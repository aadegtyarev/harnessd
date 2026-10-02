import type {
	HarnessAdapter,
	ProcessProvider,
	TransportAdapter,
	TransportEvent,
	TransportEventListener,
	TransportEventSubscription,
	TransportResult,
} from "./core/ports.js";
import { SessionManager } from "./core/session-manager.js";
import type { SessionStore } from "./core/session-store.js";
import {
	resolveStateDirectory,
	SqliteSessionStore,
} from "./core/session-store.js";
import type { HarnessEvent } from "./core/types.js";
import type { PiRpcHarnessOptions } from "./harness/pi-rpc-harness.js";
import {
	PiRpcHarnessAdapter,
	UncertainInputDeliveryError,
} from "./harness/pi-rpc-harness.js";
import { NodeProcessProvider } from "./process/node-process-provider.js";

export type ExecutionMode = "direct" | "isolated";

export class IsolationUnavailableError extends Error {
	readonly code = "ISOLATION_UNAVAILABLE";

	constructor() {
		super("Isolated execution is unavailable");
		this.name = "IsolationUnavailableError";
	}
}

export class InvalidExecutionModeError extends Error {
	readonly code = "INVALID_EXECUTION_MODE";

	constructor() {
		super("Execution mode is invalid");
		this.name = "InvalidExecutionModeError";
	}
}

export type ApplicationRequest = TransportEvent;
export type ApplicationResult = TransportResult;
export type RuntimeDispatch = (
	request: TransportEvent,
) => Promise<TransportResult>;
export type RuntimeEventListener = TransportEventListener;

const safeErrorMessages = new Map([
	["UNSUPPORTED_CAPABILITY", "Operation is not supported"],
	["INVALID_WORKING_DIRECTORY", "Working directory is invalid or inaccessible"],
	["SESSION_NOT_FOUND", "Session was not found"],
	["DUPLICATE_SESSION_ID", "Session already exists"],
	["SESSION_STORE_ERROR", "Session storage failed"],
	["INVALID_STATE_DIRECTORY", "Runtime state configuration is invalid"],
	["UNCERTAIN_INPUT_DELIVERY", "Input delivery is uncertain"],
]);

export interface ApplicationRuntimeOptions {
	readonly piExecutable: string;
	readonly executionMode?: ExecutionMode;
	readonly processProvider?: ProcessProvider;
	readonly piOptions?: Omit<PiRpcHarnessOptions, "executable">;
	readonly transports: readonly TransportAdapter[];
	readonly harnesses?: readonly HarnessAdapter[];
	readonly stateDirectory?: string;
	readonly store?: SessionStore & { close(): void };
}

export class ApplicationRuntime {
	private readonly manager: SessionManager;
	private readonly store: SessionStore & { close(): void };
	private readonly transports: readonly TransportAdapter[];
	private readonly listeners = new Set<RuntimeEventListener>();
	private readonly unsubscribeManagerEvents: () => void;
	private state: "starting" | "running" | "closing" | "closed" = "starting";
	private readonly inFlight = new Set<Promise<ApplicationResult>>();
	private closePromise: Promise<void> | undefined;
	private constructor(
		store: SessionStore & { close(): void },
		manager: SessionManager,
		transports: readonly TransportAdapter[],
	) {
		this.store = store;
		this.manager = manager;
		this.transports = transports;
		this.unsubscribeManagerEvents = manager.subscribe((event) =>
			this.publish(event),
		);
	}

	static async start(
		options: ApplicationRuntimeOptions,
	): Promise<ApplicationRuntime> {
		const mode: unknown =
			options.executionMode === undefined ? "direct" : options.executionMode;
		if (mode !== "direct" && mode !== "isolated")
			throw new InvalidExecutionModeError();
		const processProvider = options.processProvider;
		if (mode === "isolated") {
			if (options.harnesses !== undefined)
				throw new IsolationUnavailableError();
			if (!processProvider) throw new IsolationUnavailableError();
			const capabilities = processProvider.descriptor.capabilities;
			const requiredCapabilities = [
				"process.isolation",
				"process.launch",
				"process.signal",
			] as const;
			if (
				!requiredCapabilities.every((capability) =>
					capabilities.includes(capability),
				)
			)
				throw new IsolationUnavailableError();
		}
		if (!options.piExecutable) throw new TypeError("Pi executable is required");
		let store: (SessionStore & { close(): void }) | undefined;
		let manager: SessionManager | undefined;
		let runtimeToClose: ApplicationRuntime | undefined;
		const started: TransportAdapter[] = [];
		try {
			store =
				options.store ??
				(await SqliteSessionStore.open(
					resolveStateDirectory(options.stateDirectory),
				));
			manager = new SessionManager(
				store,
				options.harnesses ?? [
					new PiRpcHarnessAdapter(
						processProvider ?? new NodeProcessProvider(),
						{
							...options.piOptions,
							executable: options.piExecutable,
						},
					),
				],
			);
			const runtime = new ApplicationRuntime(
				store,
				manager,
				options.transports,
			);
			runtimeToClose = runtime;
			const subscribeEvents: TransportEventSubscription = (listener) =>
				runtime.subscribe(listener);
			for (const transport of options.transports) {
				started.push(transport);
				await transport.start(runtime.dispatch, subscribeEvents);
			}
			runtime.state = "running";
			return runtime;
		} catch (error) {
			const failures: unknown[] = [error];
			for (const transport of started.reverse())
				try {
					await transport.stop();
				} catch (stopError) {
					failures.push(stopError);
				}
			runtimeToClose?.clearListeners();
			if (manager) {
				try {
					await manager.close();
				} catch (closeError) {
					failures.push(closeError);
				}
			}
			try {
				store?.close();
			} catch (closeError) {
				failures.push(closeError);
			}
			throw failures.length === 1
				? error
				: new AggregateError(
						failures,
						"Runtime startup rollback was incomplete",
					);
		}
	}

	dispatch: RuntimeDispatch = (request) => {
		if (this.state !== "running")
			return Promise.resolve({
				requestId: request.requestId,
				ok: false,
				error: {
					code: "RUNTIME_CLOSING",
					message: "Runtime is not accepting requests",
				},
			});
		const task = this.perform(request);
		this.inFlight.add(task);
		void task.then(
			() => this.inFlight.delete(task),
			() => this.inFlight.delete(task),
		);
		return task;
	};

	subscribe(listener: RuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.state = "closing";
			this.closePromise = this.closeAll();
		}
		return this.closePromise;
	}

	private async perform(
		request: ApplicationRequest,
	): Promise<ApplicationResult> {
		try {
			let value: ApplicationResult extends { ok: true; value: infer T }
				? T
				: never;
			switch (request.kind) {
				case "list":
					value = (await this.manager.list()) as typeof value;
					break;
				case "inspect":
					value = (await this.manager.get(request.sessionId)) as typeof value;
					break;
				case "create":
					value = (await this.manager.create({
						harnessId: request.harnessId,
						cwd: request.cwd,
					})) as typeof value;
					break;
				case "stop":
					await this.manager.stop(request.sessionId);
					value = undefined as typeof value;
					break;
				case "submit":
					value = (await this.manager.submit(
						request.sessionId,
						request.text,
					)) as typeof value;
					break;
				case "cancel":
					await this.manager.cancel(request.sessionId, request.inputId);
					value = undefined as typeof value;
					break;
			}
			return { requestId: request.requestId, ok: true, value };
		} catch (error) {
			let candidate: unknown;
			try {
				candidate =
					error !== null && typeof error === "object" && "code" in error
						? error.code
						: undefined;
			} catch {
				candidate = undefined;
			}
			const code =
				typeof candidate === "string" && safeErrorMessages.has(candidate)
					? candidate
					: "OPERATION_FAILED";
			const inputId =
				error instanceof UncertainInputDeliveryError
					? error.inputId
					: undefined;
			return {
				requestId: request.requestId,
				ok: false,
				error: {
					code,
					message: safeErrorMessages.get(code) ?? "Operation failed",
					...(code === "UNCERTAIN_INPUT_DELIVERY" && inputId
						? { inputId }
						: {}),
				},
			};
		}
	}

	private publish(event: HarnessEvent): void {
		for (const listener of this.listeners)
			try {
				const result = listener(event);
				if (
					result &&
					typeof (result as PromiseLike<unknown>).then === "function"
				)
					void Promise.resolve(result).catch(() => {});
			} catch {
				/* Observer failures are isolated from session event pumps. */
			}
	}

	private clearListeners(): void {
		this.listeners.clear();
		this.unsubscribeManagerEvents();
	}

	private async closeAll(): Promise<void> {
		const failures: unknown[] = [];
		for (const transport of [...this.transports].reverse())
			try {
				await transport.stop();
			} catch (error) {
				failures.push(error);
			}
		this.clearListeners();
		await Promise.allSettled([...this.inFlight]);
		try {
			await this.manager.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			this.store.close();
		} catch (error) {
			failures.push(error);
		}
		this.state = "closed";
		if (failures.length)
			throw new AggregateError(failures, "Runtime shutdown was incomplete");
	}
}
