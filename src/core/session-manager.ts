import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
	DuplicateAdapterIdError,
	DuplicateSessionIdError,
	InvalidWorkingDirectoryError,
	requireCapability,
	SessionNotFoundError,
	UnsupportedCapabilityError,
} from "./errors.js";
import type { HarnessAdapter, HarnessInstance } from "./ports.js";
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
		const launch = this.launching.get(id);
		if (launch) await launch.catch(() => undefined);
		const session = await this.get(id);
		if (session.status === "stopped") return;
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
			await instance.shutdown();
			this.instances.delete(id);
		}
		const eventPump = this.eventPumps.get(id);
		if (eventPump) {
			eventPump.stop();
			await eventPump.promise;
		}
		await this.store.setStatus(id, "stopped");
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
		await instance.send(input);
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
				this.publishEvent({ ...next.result.value, sessionId: id });
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
