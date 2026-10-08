import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
	mergeAdapterOptions,
	validateAdapterOptions,
} from "./adapter-options.js";
import {
	DuplicateAdapterIdError,
	DuplicateSessionIdError,
	InvalidSessionNameError,
	InvalidWorkingDirectoryError,
	ReloadError,
	requireCapability,
	SessionNotFoundError,
	SessionNotResumableError,
	SessionNotStoppedError,
	UnsupportedCapabilityError,
} from "./errors.js";
import { HarnessRegistry } from "./harness-registry.js";
import type {
	HarnessAdapter,
	HarnessCommand,
	HarnessCommandResult,
	HarnessControl,
	HarnessEffortCatalog,
	HarnessInstance,
	HarnessModelCatalog,
	HarnessModelChangeResult,
	HarnessSelection,
	HarnessSessionStatus,
} from "./ports.js";
import type { SessionStore } from "./session-store.js";
import type {
	AdapterId,
	AdapterOptions,
	HarnessEvent,
	Input,
	InputId,
	SessionId,
	SessionSummary,
} from "./types.js";

export interface CreateSessionRequest {
	readonly harnessId?: AdapterId;
	readonly cwd: string;
	readonly name?: string;
	readonly id?: string;
	readonly adapterOptions?: AdapterOptions;
}

export type SessionEventListener = (event: HarnessEvent) => void;

interface ManagedEventPump {
	readonly promise: Promise<void>;
	stop(): void;
}

type EventReadResult =
	| { readonly type: "event"; readonly result: IteratorResult<HarnessEvent> }
	| { readonly type: "stop" };

export class SessionManager {
	private readonly harnesses: ReadonlyMap<AdapterId, HarnessAdapter>;
	private readonly registry: HarnessRegistry;
	private readonly defaultOptions?: AdapterOptions;
	private readonly defaultHarnessId?: AdapterId;
	private adapterOptionsFor(
		overrides?: AdapterOptions,
	): AdapterOptions | undefined {
		return mergeAdapterOptions(this.defaultOptions, overrides);
	}
	private readonly instances = new Map<SessionId, HarnessInstance>();
	private readonly eventListeners = new Set<SessionEventListener>();
	private readonly eventPumps = new Map<SessionId, ManagedEventPump>();
	private readonly creating = new Set<SessionId>();
	private readonly launchesInProgress = new Set<Promise<SessionSummary>>();
	private readonly launching = new Map<SessionId, Promise<SessionSummary>>();
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private readonly stopping = new Map<SessionId, Promise<void>>();
	private readonly resuming = new Map<SessionId, Promise<SessionSummary>>();
	private readonly terminal = new Set<SessionId>();
	private readonly recovery = new Map<SessionId, Promise<void>>();
	private readonly attempts = new Map<SessionId, number>();
	private readonly delays = new Map<SessionId, () => void>();
	private readonly unsettledInputs = new Map<SessionId, Set<InputId>>();
	private readonly reloads = new Set<SessionId>();
	private readonly reloadWaiters = new Map<SessionId, (() => void)[]>();
	private readonly recoveryErrors = new Map<SessionId, unknown>();

	constructor(
		private readonly store: SessionStore,
		harnesses: readonly HarnessAdapter[],
		options: {
			readonly defaultHarnessId?: string;
			readonly adapterOptions?: AdapterOptions;
		} = {},
	) {
		const registered = new Map<AdapterId, HarnessAdapter>();
		for (const harness of harnesses) {
			const id = harness.descriptor.id;
			if (registered.has(id)) throw new DuplicateAdapterIdError(id);
			registered.set(id, harness);
		}
		this.harnesses = registered;
		this.registry = new HarnessRegistry(harnesses);
		this.defaultOptions = options.adapterOptions
			? validateAdapterOptions(options.adapterOptions)
			: undefined;
		const canonicalDefault = options.defaultHarnessId
			? this.registry.resolve(options.defaultHarnessId)
			: undefined;
		if (options.defaultHarnessId && !canonicalDefault)
			throw new Error(`Unknown default harness: ${options.defaultHarnessId}`);
		this.defaultHarnessId = canonicalDefault;
	}

	subscribe(listener: SessionEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	list(): Promise<readonly SessionSummary[]> {
		return this.store.list();
	}

	async get(id: SessionId): Promise<SessionSummary> {
		const session = await this.store.get(id);
		if (!session) throw new SessionNotFoundError(id);
		return session;
	}

	async rename(id: SessionId, name?: string): Promise<SessionSummary> {
		await this.get(id);
		const normalizedName = normalizeSessionName(name);
		await this.store.setName(id, normalizedName);
		return this.get(id);
	}

	async delete(id: SessionId): Promise<void> {
		const session = await this.get(id);
		if (
			this.closing ||
			session.status !== "stopped" ||
			this.instances.has(id) ||
			this.creating.has(id) ||
			this.launching.has(id) ||
			this.stopping.has(id) ||
			this.recovery.has(id)
		)
			throw new SessionNotStoppedError(id);
		if (!(await this.store.delete(id))) throw new SessionNotFoundError(id);
		this.terminal.delete(id);
		this.delays.delete(id);
		this.eventPumps.delete(id);
		this.unsettledInputs.delete(id);
		this.recoveryErrors.delete(id);
	}

	create(request: CreateSessionRequest): Promise<SessionSummary> {
		if (this.closing)
			return Promise.reject(new Error("Session manager is closing"));
		const operation = this.createSession(request);
		this.launchesInProgress.add(operation);
		void operation
			.finally(() => this.launchesInProgress.delete(operation))
			.catch(() => {});
		return operation;
	}

	private async createSession(
		request: CreateSessionRequest,
	): Promise<SessionSummary> {
		const name = normalizeSessionName(request.name);
		const id = parseSessionId(request.id ?? randomUUID());
		if (this.creating.has(id)) throw new DuplicateSessionIdError(id);
		this.creating.add(id);
		try {
			if (await this.store.get(id)) throw new DuplicateSessionIdError(id);
			const selectedHarness = request.harnessId ?? this.defaultHarnessId;
			const canonicalId = selectedHarness
				? this.registry.resolve(selectedHarness)
				: undefined;
			const harness = canonicalId ? this.harnesses.get(canonicalId) : undefined;
			if (!harness)
				throw new UnsupportedCapabilityError(
					"harness.launch",
					selectedHarness ?? "default",
				);
			requireCapability(
				harness.descriptor.capabilities,
				"harness.launch",
				harness.descriptor.id,
			);
			const cwd = await validateWorkingDirectory(request.cwd);
			const adapterOptions = request.adapterOptions
				? validateAdapterOptions(request.adapterOptions)
				: undefined;
			const starting: SessionSummary = {
				id,
				...(name ? { name } : {}),
				harnessId: harness.descriptor.id,
				cwd,
				...(adapterOptions ? { adapterOptions } : {}),
				status: "starting",
			};
			let instance: HarnessInstance | undefined;
			let recordCreated = false;
			const launch = this.store.create(starting).then(async () => {
				recordCreated = true;
				try {
					instance = await harness.launch({
						sessionId: id,
						cwd,
						...(this.adapterOptionsFor(adapterOptions)
							? { adapterOptions: this.adapterOptionsFor(adapterOptions) }
							: {}),
					});
					this.instances.set(id, instance);
					const running: SessionSummary = {
						...starting,
						...(instance.nativeSessionId
							? { nativeSessionId: instance.nativeSessionId }
							: {}),
						status: "running",
					};
					await this.store.update(running);
					this.startEventPump(id, instance);
					this.watchExit(id, instance);
					return running;
				} catch (error) {
					const failures: unknown[] = [error];
					if (instance) {
						try {
							await instance.shutdown();
							this.instances.delete(id);
						} catch (shutdownError) {
							this.instances.set(id, instance);
							failures.push(shutdownError);
						}
					}
					if (recordCreated) {
						try {
							await this.store.setStatus(id, "failed");
						} catch (statusError) {
							failures.push(statusError);
						}
					}
					if (failures.length > 1) {
						throw new AggregateError(
							failures,
							`Session '${id}' startup failed and cleanup was incomplete`,
							{ cause: error },
						);
					}
					throw error;
				}
			});
			this.launching.set(id, launch);
			try {
				return await launch;
			} finally {
				if (this.launching.get(id) === launch) this.launching.delete(id);
			}
		} finally {
			this.creating.delete(id);
		}
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.closeAll();
		}
		return this.closePromise;
	}

	private async closeAll(): Promise<void> {
		while (this.launchesInProgress.size > 0) {
			await Promise.allSettled([...this.launchesInProgress]);
		}
		const failures: unknown[] = [];
		const sessionIds = new Set([
			...this.instances.keys(),
			...this.eventPumps.keys(),
			...this.recovery.keys(),
			...this.stopping.keys(),
		]);
		for (const id of sessionIds) {
			try {
				await this.stop(id);
			} catch (error) {
				failures.push(error);
			}
			const pump = this.eventPumps.get(id);
			if (pump) {
				pump.stop();
				try {
					await pump.promise;
				} catch (error) {
					failures.push(error);
				}
			}
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				"Session manager shutdown was incomplete",
			);
	}

	async stop(id: SessionId): Promise<void> {
		const current = this.stopping.get(id);
		if (current) return current;
		const stopping = this.stopSession(id);
		this.stopping.set(id, stopping);
		try {
			await stopping;
		} finally {
			if (this.stopping.get(id) === stopping) this.stopping.delete(id);
		}
	}

	private async stopSession(id: SessionId): Promise<void> {
		await this.get(id);
		this.terminal.add(id);
		this.delays.get(id)?.();
		const launch = this.launching.get(id);
		if (launch) await launch.catch(() => undefined);
		const session = await this.get(id);
		const failures: unknown[] = [];
		const recovery = this.recovery.get(id);
		if (recovery) {
			try {
				await recovery;
			} catch (error) {
				failures.push(error);
			}
		}
		const recoveryError = this.recoveryErrors.get(id);
		if (recoveryError !== undefined) {
			failures.push(recoveryError);
			this.recoveryErrors.delete(id);
		}
		const instance = this.instances.get(id);
		if (instance) {
			const harness = this.harnesses.get(session.harnessId);
			if (!harness)
				throw new UnsupportedCapabilityError("harness.stop", session.harnessId);
			requireCapability(
				harness.descriptor.capabilities,
				"harness.stop",
				harness.descriptor.id,
			);
			try {
				await instance.shutdown();
				this.instances.delete(id);
			} catch (error) {
				failures.push(error);
			}
		}
		const eventPump = this.eventPumps.get(id);
		if (eventPump) {
			eventPump.stop();
			try {
				await eventPump.promise;
			} catch (error) {
				failures.push(error);
			}
		}
		if (!this.instances.has(id) && session.status !== "stopped") {
			try {
				await this.store.setStatus(id, "stopped");
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				`Session '${id}' shutdown was incomplete`,
			);
	}

	resume(id: SessionId): Promise<SessionSummary> {
		const current = this.resuming.get(id);
		if (current) return current;
		if (this.stopping.has(id) || this.closing)
			return Promise.reject(new SessionNotResumableError(id));
		const operation = this.resumeSession(id);
		this.resuming.set(id, operation);
		this.launching.set(id, operation);
		this.launchesInProgress.add(operation);
		void operation
			.finally(() => {
				this.launchesInProgress.delete(operation);
				if (this.resuming.get(id) === operation) this.resuming.delete(id);
				if (this.launching.get(id) === operation) this.launching.delete(id);
			})
			.catch(() => {});
		return operation;
	}

	private async resumeSession(id: SessionId): Promise<SessionSummary> {
		const session = await this.get(id);
		if (session.status === "running" && this.instances.has(id)) return session;
		if (
			this.instances.has(id) ||
			session.status !== "stopped" ||
			!session.nativeSessionId
		)
			throw new SessionNotResumableError(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness?.resume) {
			if (!harness)
				throw new UnsupportedCapabilityError(
					"harness.resume",
					session.harnessId,
				);
			throw new UnsupportedCapabilityError(
				"harness.resume",
				harness.descriptor.id,
			);
		}
		requireCapability(
			harness.descriptor.capabilities,
			"harness.resume",
			harness.descriptor.id,
		);
		if (this.stopping.has(id) || this.closing)
			throw new SessionNotResumableError(id);
		this.terminal.delete(id);
		await this.store.setStatus(id, "starting");
		if (this.terminal.has(id) || this.stopping.has(id) || this.closing) {
			await this.store.setStatus(id, "stopped");
			throw new SessionNotResumableError(id);
		}
		let replacement: HarnessInstance;
		try {
			replacement = await harness.resume({
				sessionId: id,
				cwd: session.cwd,
				nativeSessionId: session.nativeSessionId,
				...(this.adapterOptionsFor(session.adapterOptions)
					? { adapterOptions: this.adapterOptionsFor(session.adapterOptions) }
					: {}),
			});
		} catch (error) {
			try {
				await this.store.setStatus(id, "stopped");
			} catch (statusError) {
				throw new AggregateError(
					[error, statusError],
					`Session '${id}' resume failed and its status could not be restored`,
				);
			}
			throw error;
		}
		if (replacement.nativeSessionId !== session.nativeSessionId) {
			this.instances.set(id, replacement);
			try {
				await replacement.shutdown();
				this.instances.delete(id);
			} catch (error) {
				throw new AggregateError(
					[error],
					`Session '${id}' resumed with a different native session and cleanup failed`,
				);
			}
			await this.store.setStatus(id, "stopped");
			throw new SessionNotResumableError(id);
		}
		this.instances.set(id, replacement);
		if (this.terminal.has(id) || this.stopping.has(id) || this.closing) {
			try {
				await replacement.shutdown();
				this.instances.delete(id);
				await this.store.setStatus(id, "stopped");
			} catch (error) {
				throw new AggregateError(
					[error],
					`Session '${id}' resume raced with stop and cleanup failed`,
				);
			}
			throw new SessionNotResumableError(id);
		}
		const running: SessionSummary = { ...session, status: "running" };
		try {
			await this.store.update(running);
		} catch (error) {
			try {
				await replacement.shutdown();
				this.instances.delete(id);
				await this.store.setStatus(id, "stopped");
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Session '${id}' resume persistence failed and cleanup was incomplete`,
				);
			}
			throw error;
		}
		if (this.terminal.has(id) || this.stopping.has(id) || this.closing) {
			try {
				await replacement.shutdown();
				this.instances.delete(id);
				await this.store.setStatus(id, "stopped");
			} catch (error) {
				throw new AggregateError(
					[error],
					`Session '${id}' resume raced with stop and cleanup failed`,
				);
			}
			throw new SessionNotResumableError(id);
		}
		this.startEventPump(id, replacement);
		this.watchExit(id, replacement);
		return running;
	}

	async submit(
		id: SessionId,
		text: string,
		images?: readonly { readonly mimeType: string; readonly data: string }[],
	): Promise<InputId> {
		return (await this.submitWithOutcome(id, text, images)).inputId;
	}

	async submitWithOutcome(
		id: SessionId,
		text: string,
		images?: readonly { readonly mimeType: string; readonly data: string }[],
		onResumed?: () => void,
	): Promise<{ readonly inputId: InputId; readonly resumed: boolean }> {
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		let session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError("input.submit", session.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			"input.submit",
			harness.descriptor.id,
		);
		let instance = this.instances.get(id);
		let resumed = false;
		if (!instance) {
			const resumeOperation =
				session.status === "stopped" ? this.resume(id) : this.resuming.get(id);
			if (resumeOperation) {
				resumed = session.status === "stopped";
				await resumeOperation;
				if (resumed) onResumed?.();
				session = await this.get(id);
				instance = this.instances.get(id);
			}
		}
		if (!instance || session.status !== "running")
			throw new SessionNotFoundError(id);
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		const input: Input = {
			id: randomUUID() as Input["id"],
			sessionId: id,
			text,
			...(images ? { images } : {}),
			createdAt: new Date(),
		};
		let unsettled = this.unsettledInputs.get(id);
		if (!unsettled) {
			unsettled = new Set();
			this.unsettledInputs.set(id, unsettled);
		}
		unsettled.add(input.id);
		try {
			await instance.send(input);
		} catch (error) {
			if (!isUncertainDelivery(error, input.id)) unsettled.delete(input.id);
			throw error;
		}
		return { inputId: input.id, resumed };
	}

	async cancel(id: SessionId, inputId: InputId): Promise<void> {
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		const session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError("harness.cancel", session.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			"harness.cancel",
			harness.descriptor.id,
		);
		const instance = this.instances.get(id);
		if (!instance || session.status !== "running")
			throw new SessionNotFoundError(id);
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		await instance.cancel(inputId);
	}

	async getSessionStatus(id: SessionId): Promise<HarnessSessionStatus> {
		const session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		const instance = this.instances.get(id);
		if (
			!harness ||
			!instance?.control ||
			session.status !== "running" ||
			!harness.descriptor.capabilities.includes("harness.session.status")
		)
			return { session };
		return { session, live: await instance.control.getStatus() };
	}

	async listModels(id: SessionId): Promise<HarnessModelCatalog> {
		const { control, harness } = await this.requireControl(
			id,
			"harness.model.list",
		);
		const models = await control.listModels();
		let current: HarnessSelection | undefined;
		if (harness.descriptor.capabilities.includes("harness.session.status"))
			current = await control.getSelection();
		return {
			models,
			...(current?.model ? { current: current.model } : {}),
		};
	}

	async listEfforts(id: SessionId): Promise<HarnessEffortCatalog> {
		const { control, harness } = await this.requireControl(
			id,
			"harness.effort.list",
		);
		const levels = await control.listEfforts();
		let current: HarnessSelection | undefined;
		if (harness.descriptor.capabilities.includes("harness.session.status"))
			current = await control.getSelection();
		return {
			levels,
			...(current?.effort ? { current: current.effort } : {}),
		};
	}

	async setModel(
		id: SessionId,
		provider: string,
		modelId: string,
		effort?: string,
	): Promise<HarnessModelChangeResult> {
		const { control, harness } = await this.requireControl(
			id,
			"harness.model.set",
		);
		if (effort !== undefined)
			requireCapability(
				harness.descriptor.capabilities,
				"harness.effort.set",
				harness.descriptor.id,
			);
		const model = await control.setModel(provider, modelId);
		if (effort === undefined) return { model };
		try {
			await control.setEffort(effort);
			return { model, effort, effortConfirmed: true };
		} catch {
			return { model, effort, effortConfirmed: false };
		}
	}

	async setEffort(id: SessionId, effort: string): Promise<void> {
		const { control } = await this.requireControl(id, "harness.effort.set");
		await control.setEffort(effort);
	}

	async listCommands(id: SessionId): Promise<readonly HarnessCommand[]> {
		const { control } = await this.requireControl(id, "harness.commands.list");
		if (!control.getCommands)
			throw new UnsupportedCapabilityError("harness.commands.list", id);
		return control.getCommands();
	}

	async runCommand(
		id: SessionId,
		name: string,
		remainder: string,
		beforeDispatch: () => boolean = () => true,
	): Promise<HarnessCommandResult> {
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		const { control } = await this.requireControl(id, "harness.commands.run");
		if (!control.runCommand)
			throw new UnsupportedCapabilityError("harness.commands.run", id);
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_BUSY");
		return control.runCommand(name, remainder, () => {
			if (this.reloads.has(id)) return false;
			return beforeDispatch();
		});
	}

	async reload(id: SessionId, beforeDispatch: () => boolean): Promise<void> {
		if (this.reloads.has(id)) throw new ReloadError("RELOAD_ALREADY_RUNNING");
		this.reloads.add(id);
		try {
			const { control } = await this.requireControl(id, "harness.reload");
			const session = await this.get(id);
			const instance = this.instances.get(id);
			if (
				this.closing ||
				this.stopping.has(id) ||
				this.terminal.has(id) ||
				session.status !== "running" ||
				!instance ||
				this.recovery.has(id) ||
				(this.unsettledInputs.get(id)?.size ?? 0) > 0
			)
				throw new ReloadError("RELOAD_BUSY");
			if (!control.reload)
				throw new UnsupportedCapabilityError("harness.reload", id);
			if (
				this.instances.get(id) !== instance ||
				this.recovery.has(id) ||
				this.stopping.has(id)
			)
				throw new ReloadError("RELOAD_BUSY");
			if (!beforeDispatch()) throw new ReloadError("RELOAD_SELECTION_CHANGED");
			await control.reload(() => {
				if (!beforeDispatch())
					throw new ReloadError("RELOAD_SELECTION_CHANGED");
				if (
					this.instances.get(id) !== instance ||
					this.closing ||
					this.stopping.has(id) ||
					this.terminal.has(id) ||
					this.recovery.has(id) ||
					(this.unsettledInputs.get(id)?.size ?? 0) > 0
				)
					throw new ReloadError("RELOAD_BUSY");
			});
		} finally {
			this.reloads.delete(id);
			for (const resolve of this.reloadWaiters.get(id) ?? []) resolve();
			this.reloadWaiters.delete(id);
		}
	}

	private waitForReload(id: SessionId): Promise<void> {
		if (!this.reloads.has(id)) return Promise.resolve();
		return new Promise((resolve) => {
			const waiters = this.reloadWaiters.get(id) ?? [];
			waiters.push(resolve);
			this.reloadWaiters.set(id, waiters);
		});
	}

	private async requireControl(
		id: SessionId,
		capability:
			| "harness.model.list"
			| "harness.model.set"
			| "harness.effort.list"
			| "harness.effort.set"
			| "harness.reload"
			| "harness.commands.list"
			| "harness.commands.run",
	): Promise<{ control: HarnessControl; harness: HarnessAdapter }> {
		const session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError(capability, session.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			capability,
			harness.descriptor.id,
		);
		const instance = this.instances.get(id);
		if (!instance || session.status !== "running")
			throw new SessionNotFoundError(id);
		if (!instance.control)
			throw new UnsupportedCapabilityError(capability, harness.descriptor.id);
		return { control: instance.control, harness };
	}

	private watchExit(id: SessionId, instance: HarnessInstance): void {
		void instance.exit
			.then(async () => {
				if (
					this.instances.get(id) !== instance ||
					this.terminal.has(id) ||
					this.closing
				)
					return;
				const pump = this.eventPumps.get(id);
				if (pump) await pump.promise.catch(() => undefined);
				if (
					this.instances.get(id) !== instance ||
					this.terminal.has(id) ||
					this.closing
				)
					return;
				for (const inputId of this.unsettledInputs.get(id) ?? []) {
					this.publishEvent({
						sessionId: id,
						kind: "input",
						inputEvent: { inputId, state: "uncertain" },
					});
				}
				this.unsettledInputs.delete(id);
				this.instances.delete(id);
				if (this.reloads.has(id)) await this.waitForReload(id);
				let task!: Promise<void>;
				task = this.recover(id)
					.catch(async (error) => {
						this.recoveryErrors.set(id, error);
						if (this.terminal.has(id) || this.closing) return;
						try {
							await this.store.setStatus(id, "failed");
						} catch (statusError) {
							this.recoveryErrors.set(
								id,
								new AggregateError([error, statusError], "Recovery failed"),
							);
							if (!this.terminal.has(id) && !this.closing)
								this.publishEvent({
									sessionId: id,
									kind: "status",
									text: "harness_recovery_failed",
								});
							return;
						}
						if (!this.terminal.has(id) && !this.closing)
							this.publishEvent({
								sessionId: id,
								kind: "status",
								text: "harness_recovery_failed",
							});
					})
					.finally(() => {
						if (this.recovery.get(id) === task) this.recovery.delete(id);
					});
				this.recovery.set(id, task);
				try {
					await task;
				} catch (error) {
					this.recoveryErrors.set(id, error);
					try {
						await this.store.setStatus(id, "failed");
						this.publishEvent({
							sessionId: id,
							kind: "status",
							text: "harness_recovery_failed",
						});
					} catch (statusError) {
						this.recoveryErrors.set(
							id,
							new AggregateError([error, statusError], "Recovery failed"),
						);
					}
				} finally {
					if (this.recovery.get(id) === task) this.recovery.delete(id);
				}
			})
			.catch(() => {});
	}

	private async recover(id: SessionId): Promise<void> {
		const session = await this.get(id);
		if (this.terminal.has(id) || this.closing) return;
		const harness = this.harnesses.get(session.harnessId);
		this.publishEvent({
			sessionId: id,
			kind: "status",
			text: "harness_restarting",
		});
		const resume = harness?.resume;
		const canResume =
			resume &&
			harness.descriptor.capabilities.includes("harness.resume") &&
			session.nativeSessionId;
		if (!canResume) {
			if (this.terminal.has(id) || this.closing) return;
			await this.store.setStatus(id, "failed");
			if (!this.terminal.has(id) && !this.closing)
				this.publishEvent({
					sessionId: id,
					kind: "status",
					text: "harness_recovery_failed",
				});
			return;
		}
		await this.store.setStatus(id, "starting");
		if (this.terminal.has(id) || this.closing) return;
		const waits = [250, 1000, 4000];
		while ((this.attempts.get(id) ?? 0) < waits.length) {
			const delay = waits[this.attempts.get(id) ?? 0] as number;
			if (this.terminal.has(id) || this.closing) return;
			await this.waitRecoveryDelay(id, delay);
			if (this.terminal.has(id) || this.closing) return;
			const attempt = (this.attempts.get(id) ?? 0) + 1;
			this.attempts.set(id, attempt);
			await this.store.setStatus(id, "starting");
			if (this.terminal.has(id) || this.closing) return;
			let replacement: HarnessInstance;
			try {
				replacement = await resume.call(harness, {
					sessionId: id,
					cwd: session.cwd,
					nativeSessionId: session.nativeSessionId,
					...(this.adapterOptionsFor(session.adapterOptions)
						? { adapterOptions: this.adapterOptionsFor(session.adapterOptions) }
						: {}),
				});
			} catch {
				if (attempt >= waits.length) {
					if (this.terminal.has(id) || this.closing) return;
					await this.store.setStatus(id, "failed");
					if (!this.terminal.has(id) && !this.closing)
						this.publishEvent({
							sessionId: id,
							kind: "status",
							text: "harness_recovery_failed",
						});
					return;
				}
				continue;
			}
			this.instances.set(id, replacement);
			if (replacement.nativeSessionId !== session.nativeSessionId) {
				await replacement.shutdown();
				this.instances.delete(id);
				if (this.terminal.has(id) || this.closing) return;
				await this.store.setStatus(id, "failed");
				if (!this.terminal.has(id) && !this.closing)
					this.publishEvent({
						sessionId: id,
						kind: "status",
						text: "harness_recovery_failed",
					});
				return;
			}
			if (this.terminal.has(id) || this.closing) {
				await replacement.shutdown();
				this.instances.delete(id);
				return;
			}
			try {
				await this.store.setStatus(id, "running");
			} catch (error) {
				try {
					await replacement.shutdown();
					this.instances.delete(id);
				} catch (shutdownError) {
					throw new AggregateError(
						[error, shutdownError],
						"Recovered harness cleanup failed",
					);
				}
				throw error;
			}
			if (this.terminal.has(id) || this.closing) {
				await replacement.shutdown();
				this.instances.delete(id);
				return;
			}
			this.startEventPump(id, replacement);
			this.watchExit(id, replacement);
			this.publishEvent({
				sessionId: id,
				kind: "status",
				text: "harness_recovered",
			});
			return;
		}
		if (!this.terminal.has(id) && !this.closing) {
			await this.store.setStatus(id, "failed");
			if (!this.terminal.has(id) && !this.closing)
				this.publishEvent({
					sessionId: id,
					kind: "status",
					text: "harness_recovery_failed",
				});
		}
	}

	private waitRecoveryDelay(
		id: SessionId,
		milliseconds: number,
	): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.delays.delete(id);
				resolve();
			}, milliseconds);
			this.delays.set(id, () => {
				clearTimeout(timer);
				this.delays.delete(id);
				resolve();
			});
		});
	}

	private startEventPump(id: SessionId, instance: HarnessInstance): void {
		const controller = new AbortController();
		let eventPump: ManagedEventPump;
		const promise = this.consumeEvents(id, instance, controller.signal).finally(
			() => {
				if (this.eventPumps.get(id) === eventPump) this.eventPumps.delete(id);
			},
		);
		eventPump = { promise, stop: () => controller.abort() };
		this.eventPumps.set(id, eventPump);
	}

	private async consumeEvents(
		id: SessionId,
		instance: HarnessInstance,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const iterator = instance.events[Symbol.asyncIterator]();
			while (true) {
				const next = await this.nextEventOrStop(iterator, signal);
				if (next.type === "stop") {
					this.closeEventIterator(iterator);
					return;
				}
				if (next.result.done) return;
				if (this.instances.get(id) !== instance) {
					this.closeEventIterator(iterator);
					return;
				}
				const event = { ...next.result.value, sessionId: id };
				if (event.kind === "input" && event.inputEvent) {
					const state = event.inputEvent.state;
					if (["completed", "failed", "uncertain"].includes(state))
						this.unsettledInputs.get(id)?.delete(event.inputEvent.inputId);
				}
				this.publishEvent(event);
			}
		} catch {
			if (this.instances.get(id) === instance) {
				this.publishEvent({
					sessionId: id,
					kind: "error",
					text: "Harness event stream failed",
					fatal: true,
				});
			}
		}
	}

	private nextEventOrStop(
		iterator: AsyncIterator<HarnessEvent>,
		signal: AbortSignal,
	): Promise<EventReadResult> {
		if (signal.aborted) return Promise.resolve({ type: "stop" });
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({ type: "stop" });
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			let pending: Promise<IteratorResult<HarnessEvent>>;
			try {
				pending = Promise.resolve(iterator.next());
			} catch (error) {
				settled = true;
				cleanup();
				reject(error);
				return;
			}
			pending.then(
				(result) => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve({ type: "event", result });
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			);
		});
	}

	private closeEventIterator(iterator: AsyncIterator<HarnessEvent>): void {
		try {
			const closing = iterator.return?.();
			if (closing) void Promise.resolve(closing).catch(() => undefined);
		} catch {
			// Closing a non-conforming iterator must not hold up session shutdown.
		}
	}

	private publishEvent(event: HarnessEvent): void {
		for (const listener of this.eventListeners) {
			try {
				const result = listener(event) as unknown;
				if (
					result !== null &&
					typeof result === "object" &&
					"then" in result &&
					typeof result.then === "function"
				) {
					void Promise.resolve(result).catch(() => {
						console.error("[harnessd] Session event observer failed");
					});
				}
			} catch {
				console.error("[harnessd] Session event observer failed");
			}
		}
	}
}

function isUncertainDelivery(error: unknown, inputId: InputId): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as {
		readonly code?: unknown;
		readonly inputId?: unknown;
	};
	return (
		candidate.code === "UNCERTAIN_INPUT_DELIVERY" &&
		candidate.inputId === inputId
	);
}

function normalizeSessionName(name?: string): string | undefined {
	if (name === undefined) return undefined;
	for (const character of name) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			throw new InvalidSessionNameError();
	}
	const normalized = name.trim().replace(/\s+/gu, " ");
	if (!normalized || [...normalized].length > 64)
		throw new InvalidSessionNameError();
	return normalized;
}

function parseSessionId(value: string): SessionId {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new TypeError(`Invalid session ID: ${value}`);
	}
	return value as SessionId;
}

async function validateWorkingDirectory(
	requestedPath: string,
): Promise<string> {
	try {
		const canonicalPath = await realpath(requestedPath);
		const metadata = await stat(canonicalPath);
		if (!metadata.isDirectory()) throw new Error("not a directory");
		await access(canonicalPath, constants.R_OK | constants.X_OK);
		return canonicalPath;
	} catch (error) {
		throw new InvalidWorkingDirectoryError(requestedPath, { cause: error });
	}
}
