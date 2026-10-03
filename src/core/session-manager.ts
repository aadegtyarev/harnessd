import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
	DuplicateAdapterIdError,
	DuplicateSessionIdError,
	InvalidWorkingDirectoryError,
	requireCapability,
	SessionNotFoundError,
	SessionNotStoppedError,
	UnsupportedCapabilityError,
} from "./errors.js";
import type {
	HarnessAdapter,
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
	HarnessEvent,
	Input,
	InputId,
	SessionId,
	SessionSummary,
} from "./types.js";

export interface CreateSessionRequest {
	readonly harnessId: AdapterId;
	readonly cwd: string;
	readonly id?: string;
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
	private readonly instances = new Map<SessionId, HarnessInstance>();
	private readonly eventListeners = new Set<SessionEventListener>();
	private readonly eventPumps = new Map<SessionId, ManagedEventPump>();
	private readonly creating = new Set<SessionId>();
	private readonly launchesInProgress = new Set<Promise<SessionSummary>>();
	private readonly launching = new Map<SessionId, Promise<SessionSummary>>();
	private closing = false;
	private closePromise: Promise<void> | undefined;
	private readonly stopping = new Map<SessionId, Promise<void>>();
	private readonly terminal = new Set<SessionId>();
	private readonly recovery = new Map<SessionId, Promise<void>>();
	private readonly attempts = new Map<SessionId, number>();
	private readonly delays = new Map<SessionId, () => void>();
	private readonly unsettledInputs = new Map<SessionId, Set<InputId>>();
	private readonly recoveryErrors = new Map<SessionId, unknown>();

	constructor(
		private readonly store: SessionStore,
		harnesses: readonly HarnessAdapter[],
	) {
		const registered = new Map<AdapterId, HarnessAdapter>();
		for (const harness of harnesses) {
			const id = harness.descriptor.id;
			if (registered.has(id)) throw new DuplicateAdapterIdError(id);
			registered.set(id, harness);
		}
		this.harnesses = registered;
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
		const id = parseSessionId(request.id ?? randomUUID());
		if (this.creating.has(id)) throw new DuplicateSessionIdError(id);
		this.creating.add(id);
		try {
			if (await this.store.get(id)) throw new DuplicateSessionIdError(id);
			const harness = this.harnesses.get(request.harnessId);
			if (!harness)
				throw new UnsupportedCapabilityError(
					"harness.launch",
					request.harnessId,
				);
			requireCapability(
				harness.descriptor.capabilities,
				"harness.launch",
				harness.descriptor.id,
			);
			const cwd = await validateWorkingDirectory(request.cwd);
			const starting: SessionSummary = {
				id,
				harnessId: request.harnessId,
				cwd,
				status: "starting",
			};
			let instance: HarnessInstance | undefined;
			let recordCreated = false;
			const launch = this.store.create(starting).then(async () => {
				recordCreated = true;
				try {
					instance = await harness.launch({ sessionId: id, cwd });
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

	async submit(id: SessionId, text: string): Promise<InputId> {
		const session = await this.get(id);
		const harness = this.harnesses.get(session.harnessId);
		if (!harness)
			throw new UnsupportedCapabilityError("input.submit", session.harnessId);
		requireCapability(
			harness.descriptor.capabilities,
			"input.submit",
			harness.descriptor.id,
		);
		const instance = this.instances.get(id);
		if (!instance || session.status !== "running")
			throw new SessionNotFoundError(id);
		const input: Input = {
			id: randomUUID() as Input["id"],
			sessionId: id,
			text,
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
		return input.id;
	}

	async cancel(id: SessionId, inputId: InputId): Promise<void> {
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

	private async requireControl(
		id: SessionId,
		capability:
			| "harness.model.list"
			| "harness.model.set"
			| "harness.effort.list"
			| "harness.effort.set",
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
