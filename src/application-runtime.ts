import type {
	AgentFileSendHandler,
	AgentFileSendTransport,
	HarnessAdapter,
	ProcessProvider,
	ToolPermissionTransport,
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
import type { AdapterOptions, HarnessEvent } from "./core/types.js";
import { describeError } from "./error-diagnostics.js";
import { ClaudeCodeHarnessAdapter } from "./harness/claude-code-harness.js";
import type { PiRpcHarnessOptions } from "./harness/pi-rpc-harness.js";
import {
	InputNotDeliveredError,
	PiControlError,
	PiRpcHarnessAdapter,
	PiStartupError,
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
	[
		"INVALID_SESSION_NAME",
		"Session name must be a single line of 1–64 characters.",
	],
	["SESSION_NOT_STOPPED", "Stop the session before deleting it with /stop."],
	[
		"SESSION_NOT_RESUMABLE",
		"Session cannot be resumed; ensure it is stopped and has a saved Pi session.",
	],
	["DUPLICATE_SESSION_ID", "Session already exists"],
	["SESSION_STORE_ERROR", "Session storage failed"],
	["INVALID_STATE_DIRECTORY", "Runtime state configuration is invalid"],
	[
		"PI_EXECUTABLE_NOT_FOUND",
		"Pi CLI was not found; check HARNESSD_PI_EXECUTABLE.",
	],
	[
		"PI_EXECUTABLE_NOT_ACCESSIBLE",
		"Pi CLI cannot be executed; check its path and permissions.",
	],
	[
		"PI_RPC_STARTUP_TIMEOUT",
		"Pi did not answer its startup RPC in time; check its Node.js version and configuration.",
	],
	[
		"PI_EXITED_BEFORE_READY",
		"Pi exited before session startup; check the installed Pi CLI and runtime.",
	],
	[
		"PI_STARTUP_FAILED",
		"Pi did not start successfully; check its CLI, runtime, and authentication.",
	],
	["UNCERTAIN_INPUT_DELIVERY", "Input delivery is uncertain"],
	["INPUT_NOT_DELIVERED", "Input was not delivered"],
	[
		"PI_CONTROL_FAILED",
		"Pi did not confirm this control request; check /status before retrying.",
	],
	["RELOAD_BUSY", "The session is busy; wait for Pi to become idle."],
	["RELOAD_ALREADY_RUNNING", "A reload is already in progress."],
	["RELOAD_SELECTION_CHANGED", "The selected session changed before reload."],
	[
		"HARNESS_OPTIONS_BUSY",
		"The session must be provably idle before changing these options.",
	],
	[
		"DANGEROUS_OPTION_CONFIRMATION_REQUIRED",
		"Explicit confirmation is required for this permission mode.",
	],
	[
		"HARNESS_OPTIONS_RESTART_FAILED_ROLLED_BACK",
		"The option change failed; previous options and the same native session were restored.",
	],
	[
		"HARNESS_OPTIONS_RESTART_AND_ROLLBACK_FAILED",
		"Option change and rollback could not be confirmed; the session is stopped and no fallback was started.",
	],
	[
		"HARNESS_OPTIONS_SHUTDOWN_UNCONFIRMED",
		"The previous process could not be confirmed stopped; no replacement was started.",
	],
	[
		"COMMAND_DISCOVERY_FAILED",
		"Pi command discovery is temporarily unavailable.",
	],
	[
		"COMMAND_NOT_AVAILABLE",
		"That Pi extension command is no longer available.",
	],
	[
		"COMMAND_SELECTION_CHANGED",
		"The selected session changed; the extension command was not sent.",
	],
	["COMMAND_REJECTED", "Pi did not accept that extension command."],
	[
		"COMMAND_UNCERTAIN",
		"Pi may have accepted the extension command; it was not retried.",
	],
	["MODEL_NOT_AVAILABLE", "Model is not available; use /model to see choices."],
	[
		"EFFORT_NOT_SUPPORTED",
		"Effort is not supported by this model; use /effort to see valid levels.",
	],
]);

function requestReference(requestId: string): string | undefined {
	const reference = requestId.replace(/[^a-f0-9]/gi, "").slice(0, 8);
	return /^[a-f0-9]{8}$/i.test(reference) ? reference.toLowerCase() : undefined;
}

const safeErrorTypes = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
]);

function safeErrorType(error: unknown): string {
	try {
		if (!(error instanceof Error)) return "NonError";
		return safeErrorTypes.has(error.name) ? error.name : "Error";
	} catch {
		return "Error";
	}
}

function safeErrorOrigin(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const frame = error.stack
			?.split("\n")
			.slice(1)
			.find((line) => line.includes(":"));
		const match = frame?.match(
			/\/([A-Za-z0-9_.-]+\.(?:[cm]?js|ts)):(\d+):\d+\)?\s*$/,
		);
		return match ? `${match[1]}:${match[2]}` : undefined;
	} catch {
		return undefined;
	}
}

function safeOperationKind(value: string): string {
	return /^[a-z_]{1,32}$/.test(value) ? value : "unknown";
}

export interface ApplicationRuntimeOptions {
	readonly piExecutable: string;
	readonly claudeExecutable?: string;
	readonly executionMode?: ExecutionMode;
	readonly processProvider?: ProcessProvider;
	readonly piOptions?: Omit<
		PiRpcHarnessOptions,
		"agentFileSend" | "executable"
	>;
	readonly transports: readonly TransportAdapter[];
	readonly harnesses?: readonly HarnessAdapter[];
	readonly defaultHarnessId?: string;
	readonly adapterOptions?: AdapterOptions;
	readonly stateDirectory?: string;
	readonly store?: SessionStore & { close(): void };
	/**
	 * Upper bound on waiting for in-flight requests during shutdown before the
	 * session manager is closed (default 5 s), keeping a service stop well under
	 * systemd's `TimeoutStopSec`.
	 */
	readonly requestDrainTimeoutMs?: number;
}

const DEFAULT_REQUEST_DRAIN_TIMEOUT_MS = 5_000;

export class ApplicationRuntime {
	private readonly manager: SessionManager;
	private readonly store: SessionStore & { close(): void };
	private readonly transports: readonly TransportAdapter[];
	private readonly listeners = new Set<RuntimeEventListener>();
	private readonly unsubscribeManagerEvents: () => void;
	private state: "starting" | "running" | "closing" | "closed" = "starting";
	private readonly inFlight = new Set<Promise<ApplicationResult>>();
	private closePromise: Promise<void> | undefined;
	private readonly requestDrainTimeoutMs: number;
	private constructor(
		store: SessionStore & { close(): void },
		manager: SessionManager,
		transports: readonly TransportAdapter[],
		requestDrainTimeoutMs = DEFAULT_REQUEST_DRAIN_TIMEOUT_MS,
	) {
		this.requestDrainTimeoutMs = requestDrainTimeoutMs;
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
		const agentFileSenders = options.transports.filter(
			(transport): transport is TransportAdapter & AgentFileSendTransport =>
				typeof (transport as Partial<AgentFileSendTransport>).sendAgentFile ===
				"function",
		);
		if (agentFileSenders.length > 1)
			throw new TypeError("Only one agent file-send transport is supported");
		const agentFileSend: AgentFileSendHandler | undefined = agentFileSenders[0]
			? (request) => agentFileSenders[0].sendAgentFile(request)
			: undefined;
		const permissionTransports = options.transports.filter(
			(transport): transport is TransportAdapter & ToolPermissionTransport =>
				typeof (transport as Partial<ToolPermissionTransport>)
					.requestToolPermission === "function",
		);
		if (permissionTransports.length > 1)
			throw new TypeError("Only one tool-permission transport is supported");
		const toolPermissionHandler = permissionTransports[0]
			? (
					request: Parameters<
						ToolPermissionTransport["requestToolPermission"]
					>[0],
				) => permissionTransports[0].requestToolPermission(request)
			: undefined;
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
			const defaultHarnessId =
				options.defaultHarnessId ??
				(options.harnesses === undefined ? "pi-rpc" : undefined);
			const sessionManager = new SessionManager(
				store,
				options.harnesses ?? [
					new ClaudeCodeHarnessAdapter(
						processProvider ?? new NodeProcessProvider(),
						{
							executable: options.claudeExecutable ?? "claude",
							...(agentFileSend ? { agentFileSend } : {}),
						},
					),
					new PiRpcHarnessAdapter(
						processProvider ?? new NodeProcessProvider(),
						{
							...options.piOptions,
							executable: options.piExecutable,
							...(agentFileSend ? { agentFileSend } : {}),
						},
					),
				],
				{
					...(defaultHarnessId ? { defaultHarnessId } : {}),
					...(options.adapterOptions
						? { adapterOptions: options.adapterOptions }
						: {}),
					...(toolPermissionHandler ? { toolPermissionHandler } : {}),
				},
			);
			manager = sessionManager;
			await sessionManager.reconcileAfterRestart();
			const runtime = new ApplicationRuntime(
				store,
				sessionManager,
				options.transports,
				options.requestDrainTimeoutMs,
			);
			runtimeToClose = runtime;
			const subscribeEvents: TransportEventSubscription = (listener) =>
				runtime.subscribe(listener);
			for (const transport of options.transports) {
				started.push(transport);
				await transport.start(
					runtime.dispatch,
					subscribeEvents,
					() => sessionManager.list(),
					(sessionId) => sessionManager.getHarnessCapabilities(sessionId),
					() => sessionManager.listHarnesses(),
				);
			}
			runtime.state = "running";
			return runtime;
		} catch (error) {
			const failures: unknown[] = [error];
			manager?.beginClose();
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
		let resumed = false;
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
						name: request.name,
						adapterOptions: request.adapterOptions,
						confirmedDangerousOptions: request.confirmedDangerousOptions,
					})) as typeof value;
					break;
				case "rename":
					value = (await this.manager.rename(
						request.sessionId,
						request.name,
					)) as typeof value;
					break;
				case "stop":
					await this.manager.stop(request.sessionId);
					value = undefined as typeof value;
					break;
				case "resume":
					value = (await this.manager.resume(
						request.sessionId,
					)) as typeof value;
					break;
				case "delete":
					await this.manager.delete(request.sessionId);
					value = undefined as typeof value;
					break;
				case "submit": {
					const outcome = await this.manager.submitWithOutcome(
						request.sessionId,
						request.text,
						request.images,
						() => {
							resumed = true;
						},
					);
					value = outcome.inputId as typeof value;
					resumed = outcome.resumed;
					break;
				}
				case "cancel":
					await this.manager.cancel(request.sessionId, request.inputId);
					value = undefined as typeof value;
					break;
				case "cancel_current":
					await this.manager.cancelCurrent(request.sessionId);
					value = undefined as typeof value;
					break;
				case "session_status":
					value = (await this.manager.getSessionStatus(
						request.sessionId,
					)) as typeof value;
					break;
				case "model_list":
					value = (await this.manager.listModels(
						request.sessionId,
					)) as typeof value;
					break;
				case "model_set":
					value = (await this.manager.setModel(
						request.sessionId,
						request.provider,
						request.modelId,
						request.effort,
					)) as typeof value;
					break;
				case "effort_list":
					value = (await this.manager.listEfforts(
						request.sessionId,
					)) as typeof value;
					break;
				case "effort_set":
					await this.manager.setEffort(request.sessionId, request.effort);
					value = undefined as typeof value;
					break;
				case "adapter_options_list":
					value = (await this.manager.listAdapterOptions(
						request.sessionId,
					)) as typeof value;
					break;
				case "adapter_options_set":
					value = (await this.manager.updateAdapterOptions(
						request.sessionId,
						request.update,
					)) as typeof value;
					break;
				case "reload":
					await this.manager.reload(request.sessionId, request.beforeDispatch);
					value = undefined as typeof value;
					break;
				case "command_list":
					value = (await this.manager.listCommands(
						request.sessionId,
					)) as typeof value;
					break;
				case "command_run":
					value = (await this.manager.runCommand(
						request.sessionId,
						request.name,
						request.remainder,
						request.beforeDispatch,
					)) as typeof value;
					break;
			}
			return {
				requestId: request.requestId,
				ok: true,
				value,
				...(request.kind === "submit" ? { resumed } : {}),
			};
		} catch (error) {
			if (error instanceof PiStartupError)
				console.error(`harnessd: Pi startup failed (${error.code})`);
			if (error instanceof PiControlError)
				console.error(`harnessd: Pi control failed (${error.code})`);
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
			const reference =
				code === "OPERATION_FAILED"
					? requestReference(request.requestId)
					: undefined;
			const origin = safeErrorOrigin(error);
			const diagnostic = {
				reference: reference ?? "unavailable",
				kind: safeOperationKind(request.kind),
				errorType: safeErrorType(error),
				...(origin ? { origin } : {}),
			};
			const detail = describeError(
				error,
				[
					process.env.HARNESSD_TELEGRAM_BOT_TOKEN,
					request.kind === "submit" ? request.text : undefined,
				],
				!(error instanceof PiStartupError || error instanceof PiControlError),
			);
			console.error(
				`harnessd: request failure ${JSON.stringify(diagnostic)}\n${detail}`,
			);
			const inputId =
				error instanceof UncertainInputDeliveryError ||
				error instanceof InputNotDeliveredError
					? error.inputId
					: undefined;
			return {
				requestId: request.requestId,
				ok: false,
				error: {
					code,
					// A non-delivery carries only the harness's safe, redacted reason.
					message:
						error instanceof InputNotDeliveredError
							? error.message
							: `${safeErrorMessages.get(code) ?? (reference ? `Operation failed (ref ${reference})` : "Operation failed")}\n\n${detail}`,
					...(request.kind === "submit" && resumed ? { resumed: true } : {}),
					...((code === "UNCERTAIN_INPUT_DELIVERY" ||
						code === "INPUT_NOT_DELIVERED") &&
					inputId
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
		// From here on a harness exit is shutdown, not a crash to recover from.
		this.manager.beginClose();
		for (const transport of [...this.transports].reverse())
			try {
				await transport.stop();
			} catch (error) {
				failures.push(error);
			}
		this.clearListeners();
		// Bounded: manager close stops the sessions that a stuck request may wait on.
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled([...this.inFlight]),
			new Promise<void>((resolve) => {
				drainTimer = setTimeout(resolve, this.requestDrainTimeoutMs);
			}),
		]);
		if (drainTimer !== undefined) clearTimeout(drainTimer);
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
