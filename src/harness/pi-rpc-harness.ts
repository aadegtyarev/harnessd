import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Capability } from "../core/errors.js";
import { ReloadError, requireCapability } from "../core/errors.js";
import type {
	AgentFileSendHandler,
	HarnessAdapter as HarnessAdapterPort,
	HarnessCommand,
	HarnessCommandResult,
	HarnessControl,
	HarnessInstance,
	HarnessLaunchRequest,
	HarnessLiveStatus,
	HarnessModelInfo,
	HarnessSelection,
	HarnessUsageStats,
	ManagedProcess,
	ProcessProvider,
} from "../core/ports.js";
import type {
	AdapterId,
	HarnessAnomaly,
	HarnessEvent,
	HarnessStop,
	Input,
	InputEvent,
	InputFailure,
	InputFailureReason,
	InputId,
	SessionId,
} from "../core/types.js";
import {
	redactDiagnosticText,
	truncateDiagnostic,
} from "../error-diagnostics.js";
import {
	type AgentFileSendBridge,
	startAgentFileSendBridge,
} from "./agent-file-send-bridge.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "./agent-file-send-protocol.js";
import {
	INPUT_CANCELED_DETAIL,
	InputNotDeliveredError,
	UncertainInputDeliveryError,
} from "./input-delivery-error.js";
import {
	bashExitDetail,
	coordinationSummary,
	subagentNotice,
	taskActivity,
	thoughtSummary,
} from "./pi-activity-details.js";
import {
	anomaly,
	anomalyDetail,
	anomalyText,
	MAX_CONSECUTIVE_ANOMALIES,
	OVERSIZED_HEAD_CHARS,
	safeToken,
} from "./pi-rpc-anomaly.js";
import { scanRecordHead } from "./pi-rpc-record-head.js";

export interface PiRpcHarnessOptions {
	readonly executable: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly agentFileSend?: AgentFileSendHandler;
	readonly startupTimeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly exitDrainTimeoutMs?: number;
	/** How long a prompt submitted during Pi compaction is held before it fails. */
	readonly compactionHoldTimeoutMs?: number;
	readonly maxRecordBytes?: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 2048;
/** Raw stderr kept for redaction; larger than the tail so a cut secret is redacted first. */
const STDERR_RAW_LIMIT = 4 * STDERR_TAIL_LIMIT;
const RELOAD_COMMAND_ENV = "HARNESSD_PI_RELOAD_COMMAND";
const RELOAD_COMMAND_DESCRIPTION = "harnessd internal reload command";
const COST_REPORT_CUSTOM_TYPE = "pi-ad-session-usage:report";

export {
	InputNotDeliveredError,
	UncertainInputDeliveryError,
} from "./input-delivery-error.js";

export type PiStartupErrorCode =
	| "PI_EXECUTABLE_NOT_FOUND"
	| "PI_EXECUTABLE_NOT_ACCESSIBLE"
	| "PI_RPC_STARTUP_TIMEOUT"
	| "PI_EXITED_BEFORE_READY"
	| "PI_STARTUP_FAILED";

export class PiStartupError extends Error {
	constructor(
		readonly code: PiStartupErrorCode,
		options?: ErrorOptions,
	) {
		super("Pi RPC startup failed", options);
		this.name = "PiStartupError";
	}
}

export type PiControlErrorCode =
	| "PI_CONTROL_FAILED"
	| "MODEL_NOT_AVAILABLE"
	| "EFFORT_NOT_SUPPORTED"
	| "RELOAD_BUSY"
	| "RELOAD_SELECTION_CHANGED"
	| "COMMAND_DISCOVERY_FAILED"
	| "COMMAND_NOT_AVAILABLE"
	| "COMMAND_SELECTION_CHANGED"
	| "COMMAND_REJECTED"
	| "COMMAND_UNCERTAIN";

export class PiControlError extends Error {
	constructor(
		readonly code: PiControlErrorCode,
		options?: ErrorOptions,
	) {
		super("Pi session control request failed", options);
		this.name = "PiControlError";
	}
}

async function resolveNodeShebang(
	executable: string,
	cwd: string,
	env: Readonly<Record<string, string>> | undefined,
): Promise<
	| { readonly executable: string; readonly argsPrefix: readonly string[] }
	| undefined
> {
	const candidates = path.isAbsolute(executable)
		? [executable]
		: executable.includes(path.sep)
			? [path.resolve(cwd, executable)]
			: (env?.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin"))
					.split(path.delimiter)
					.map((directory) => path.resolve(cwd, directory || ".", executable));
	for (const candidate of candidates) {
		try {
			await access(candidate, fsConstants.X_OK);
			if (!(await stat(candidate)).isFile()) continue;
		} catch {
			continue;
		}
		if (await hasEnvNodeShebang(candidate))
			return { executable: process.execPath, argsPrefix: [candidate] };
		return undefined;
	}
	return undefined;
}

async function hasEnvNodeShebang(filePath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		if (!(await stat(filePath)).isFile()) return false;
		handle = await open(
			filePath,
			fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0),
		);
		if (!(await handle.stat()).isFile()) return false;
		const buffer = Buffer.alloc(128);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.split("\n", 1)[0];
		return /^#!\s*\/usr\/bin\/env[ \t]+node[ \t]*\r?$/.test(firstLine ?? "");
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => {});
	}
}

function toPiStartupError(
	error: unknown,
	phase: "launch" | "ready",
): PiStartupError {
	if (error instanceof PiStartupError) return error;
	const code = nestedErrorCode(error);
	if (code === "ENOENT")
		return new PiStartupError("PI_EXECUTABLE_NOT_FOUND", { cause: error });
	if (code === "EACCES" || code === "EPERM")
		return new PiStartupError("PI_EXECUTABLE_NOT_ACCESSIBLE", {
			cause: error,
		});
	const message = error instanceof Error ? error.message : "";
	if (
		message === "Pi RPC startup timed out" ||
		(phase === "ready" && message === "Pi RPC get_state timed out")
	)
		return new PiStartupError("PI_RPC_STARTUP_TIMEOUT", { cause: error });
	if (message.startsWith("Pi process exited ("))
		return new PiStartupError("PI_EXITED_BEFORE_READY", { cause: error });
	if (
		phase === "ready" &&
		message !== "Pi RPC get_state returned no session ID"
	)
		throw error;
	return new PiStartupError("PI_STARTUP_FAILED", { cause: error });
}

function nestedErrorCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof current !== "object" || current === null) return undefined;
		if ("code" in current && typeof current.code === "string")
			return current.code;
		current = "cause" in current ? current.cause : undefined;
	}
	return undefined;
}

function within<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

const controlledFlags = [
	"--mode",
	"--session",
	"--session-id",
	"--no-session",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--fork",
	"--print",
	"-p",
	"--export",
	"--help",
	"-h",
	"--version",
	"-v",
	"--",
];

export class PiRpcHarnessAdapter implements HarnessAdapterPort {
	get descriptor(): HarnessAdapterPort["descriptor"] {
		const capabilities: Capability[] = [
			"harness.launch",
			"harness.stop",
			"harness.resume",
			"harness.cancel",
			"harness.session.status",
			"harness.model.list",
			"harness.model.set",
			"harness.effort.list",
			"harness.effort.set",
			"harness.reload",
			"harness.commands.list",
			"harness.commands.run",
			"input.submit",
		];
		if (this.options.agentFileSend) capabilities.push("harness.file.send");
		return { id: "pi-rpc" as AdapterId, aliases: ["pi"], capabilities };
	}
	constructor(
		private readonly processes: ProcessProvider,
		private readonly options: PiRpcHarnessOptions,
	) {
		if (!options.executable) throw new TypeError("Pi executable is required");
		for (const [name, value] of [
			["startupTimeoutMs", options.startupTimeoutMs],
			["commandTimeoutMs", options.commandTimeoutMs],
			["shutdownTimeoutMs", options.shutdownTimeoutMs],
			["exitDrainTimeoutMs", options.exitDrainTimeoutMs],
			["compactionHoldTimeoutMs", options.compactionHoldTimeoutMs],
		] as const) {
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value) ||
					value <= 0 ||
					value > MAX_TIMER_DELAY_MS)
			)
				throw new TypeError(
					`${name} must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`,
				);
		}
		if (
			options.maxRecordBytes !== undefined &&
			(!Number.isSafeInteger(options.maxRecordBytes) ||
				options.maxRecordBytes <= 0 ||
				options.maxRecordBytes > MAX_RECORD_BYTES)
		)
			throw new TypeError(
				`maxRecordBytes must be from 1 to ${MAX_RECORD_BYTES}`,
			);
	}
	launch(request: HarnessLaunchRequest): Promise<HarnessInstance> {
		return this.start(request, false);
	}
	resume(request: HarnessLaunchRequest): Promise<HarnessInstance> {
		if (!request.nativeSessionId)
			return Promise.reject(
				new Error("A native Pi session ID is required to resume"),
			);
		return this.start(request, true);
	}
	private async start(
		request: HarnessLaunchRequest,
		resume: boolean,
	): Promise<HarnessInstance> {
		requireCapability(
			this.processes.descriptor.capabilities,
			"process.launch",
			this.processes.descriptor.id,
		);
		requireCapability(
			this.processes.descriptor.capabilities,
			"process.signal",
			this.processes.descriptor.id,
		);
		const args = [...(this.options.args ?? [])];
		if (
			args.some((arg) =>
				controlledFlags.some(
					(flag) => arg === flag || arg.startsWith(`${flag}=`),
				),
			)
		)
			throw new Error(
				"Pi mode and session arguments are controlled by the adapter",
			);
		args.push("--mode", "rpc");
		if (resume) args.push("--session", request.nativeSessionId as string);
		const launch = await resolveNodeShebang(
			this.options.executable,
			request.cwd,
			this.options.env,
		);
		let fileSendBridge:
			| Awaited<ReturnType<typeof startAgentFileSendBridge>>
			| undefined;
		const reloadCommand = `harnessd-reload-${randomUUID()}`;
		let child: ManagedProcess;
		try {
			const adapterPath = fileURLToPath(import.meta.url);
			args.push(
				"--extension",
				path.join(
					path.dirname(adapterPath),
					`pi-reload-extension${path.extname(adapterPath)}`,
				),
			);
			if (this.options.agentFileSend) {
				fileSendBridge = await startAgentFileSendBridge(
					request.sessionId,
					this.options.agentFileSend,
				);
				args.push(
					"--extension",
					path.join(
						path.dirname(adapterPath),
						`agent-file-send-extension${path.extname(adapterPath)}`,
					),
				);
			}
			child = await this.processes.launch({
				executable: launch?.executable ?? this.options.executable,
				args: [...(launch?.argsPrefix ?? []), ...args],
				cwd: request.cwd,
				env: {
					...(this.options.env ?? {}),
					[RELOAD_COMMAND_ENV]: reloadCommand,
					...(fileSendBridge
						? {
								[AGENT_FILE_SEND_URL_ENV]: fileSendBridge.url,
								[AGENT_FILE_SEND_TOKEN_ENV]: fileSendBridge.token,
							}
						: {}),
				},
				stdio: "pipe",
			});
		} catch (error) {
			await fileSendBridge?.close().catch(() => {});
			throw toPiStartupError(error, "launch");
		}
		if (!child.stdin || !child.stdout || !child.stderr) {
			await terminateChild(child, this.options.shutdownTimeoutMs ?? 1000);
			await fileSendBridge?.close().catch(() => {});
			throw new PiStartupError("PI_STARTUP_FAILED");
		}
		const instance = new PiRpcInstance(
			child,
			request.sessionId,
			this.options,
			reloadCommand,
			fileSendBridge,
		);
		try {
			await instance.ready(resume ? request.nativeSessionId : undefined);
			return instance;
		} catch (error) {
			await instance.shutdown().catch(() => {});
			let failure: unknown;
			try {
				failure = toPiStartupError(error, "ready");
			} catch (unmapped) {
				failure = unmapped;
			}
			const tail = instance.diagnosticTail();
			if (tail && failure instanceof Error && Object.isExtensible(failure))
				// Journal-only: non-enumerable so it is not serialized with the error.
				Object.defineProperty(failure, "diagnosticTail", {
					value: tail,
					enumerable: false,
					configurable: true,
				});
			throw failure;
		}
	}
}

async function terminateChild(
	child: ManagedProcess,
	waitMs: number,
): Promise<void> {
	child.stdin?.end();
	const exited = child.exit.then(
		() => true,
		() => true,
	);
	if (
		await within(exited, waitMs, "graceful exit timed out").catch(() => false)
	)
		return;
	try {
		await child.sendSignal("SIGTERM");
	} catch {
		/* already exited */
	}
	if (await within(exited, waitMs, "TERM exit timed out").catch(() => false))
		return;
	try {
		await child.sendSignal("SIGKILL");
	} catch {
		/* already exited */
	}
	if (!(await within(exited, waitMs, "KILL exit timed out").catch(() => false)))
		throw new Error("Pi process did not exit after SIGKILL");
}

interface PendingCommand {
	command: string;
	inputId?: InputId;
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
	retainAfterTimeout?: boolean;
	isReload?: boolean;
}
interface AbortGate {
	promise: Promise<void>;
	release: () => void;
}
interface CostResultWaiter {
	active: boolean;
	promise: Promise<string>;
	resolve(value: string): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}
interface ActiveInput {
	id: InputId;
	sentAsSteer: boolean;
	accepted: boolean;
	settled: boolean;
	uncertain: boolean;
	uncertainReported: boolean;
	canceling: boolean;
	/** Waiting for Pi compaction to finish; not yet written. Ends the hold early. */
	held?: (outcome: "canceled") => void;
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function commandInfo(value: unknown): HarnessCommand | undefined {
	const command = recordValue(value);
	if (
		command?.source !== "extension" ||
		typeof command.name !== "string" ||
		!/^[a-z][a-z0-9_-]{0,31}$/.test(command.name) ||
		command.name === "reload"
	)
		return undefined;
	const description =
		typeof command.description === "string"
			? command.description
					.replace(/[\p{Cc}\p{Cf}]/gu, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 256)
			: "";
	return { name: command.name, description };
}
function modelInfo(value: unknown): HarnessModelInfo | undefined {
	const model = recordValue(value);
	if (
		!model ||
		typeof model.provider !== "string" ||
		typeof model.id !== "string"
	)
		return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: typeof model.name === "string" ? model.name : model.id,
	};
}
function safeCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}
function usageStats(value: unknown): HarnessUsageStats | undefined {
	const stats = recordValue(value);
	if (!stats) return undefined;
	const tokens = recordValue(stats.tokens);
	const totalTokens = safeCount(tokens?.total);
	const inputTokens = safeCount(tokens?.input);
	const outputTokens = safeCount(tokens?.output);
	const cacheReadTokens = safeCount(tokens?.cacheRead);
	const cacheWriteTokens = safeCount(tokens?.cacheWrite);
	const costUsd = safeCount(stats.cost);
	const context = recordValue(stats.contextUsage);
	const contextTokens =
		context && "tokens" in context
			? context.tokens === null
				? null
				: safeCount(context.tokens)
			: undefined;
	const contextWindow = safeCount(context?.contextWindow);
	const contextPercent =
		context && "percent" in context
			? context.percent === null
				? null
				: safeCount(context.percent)
			: undefined;
	const usage: HarnessUsageStats = {
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(contextPercent !== undefined ? { contextPercent } : {}),
	};
	return Object.keys(usage).length ? usage : undefined;
}
function toolActivitySummary(name: string, value: unknown): string {
	const args = recordValue(value);
	if (!args) return name;
	const pathValue =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: undefined;
	const lines =
		typeof args.start_line === "number"
			? args.start_line
			: typeof args.offset === "number"
				? args.offset
				: undefined;
	const range = lines === undefined ? "" : ` (line ${lines})`;
	const coordination = coordinationSummary(name, args);
	if (coordination) return truncateDiagnostic(coordination, 700);
	let summary = name;
	if (name === "bash" && typeof args.command === "string")
		summary = `bash: ${args.command}`;
	else if (["read", "write", "edit"].includes(name))
		summary = `${name}: ${pathValue ?? "file"}${range}`;
	else if (["grep", "find"].includes(name)) {
		const pattern = args.pattern ?? args.query;
		summary = `${name}: ${typeof pattern === "string" ? pattern : ""}${pathValue ? ` — ${pathValue}` : ""}`;
	} else if (name === "subagent") {
		const agent = typeof args.agent === "string" ? args.agent : "workflow";
		const task =
			typeof args.task === "string"
				? args.task.replace(/\s+/g, " ").trim()
				: "";
		summary = `subagent · ${agent}${task ? ` · ${task}` : ""}`;
	}
	return truncateDiagnostic(redactDiagnosticText(summary), 700);
}
/** English journal/fallback detail for each non-delivery harnessd decides itself. */
const INPUT_FAILURE_DETAIL = {
	hold_timeout: "Pi compaction did not finish in time; the input was not sent",
	held_and_stopped: "Pi stopped before the held input was sent",
	canceled: INPUT_CANCELED_DETAIL,
} as const satisfies Partial<Record<InputFailureReason, string>>;
type HarnessdInputFailure = keyof typeof INPUT_FAILURE_DETAIL;
interface InputNonDelivery {
	readonly detail: string;
	readonly failure: InputFailure;
}
function nonDelivery(reason: HarnessdInputFailure): InputNonDelivery {
	return { detail: INPUT_FAILURE_DETAIL[reason], failure: { reason } };
}
function notDeliveredError(
	inputId: InputId,
	reason: HarnessdInputFailure,
): InputNotDeliveredError {
	const { detail, failure } = nonDelivery(reason);
	return new InputNotDeliveredError(inputId, detail, failure);
}
/** "Pi rejected the prompt" plus Pi's own redacted, bounded reason when it sent one. */
function promptRejection(
	response: Record<string, unknown>,
	redactions: readonly (string | undefined)[],
): InputNonDelivery {
	const reason =
		typeof response.error === "string" && response.error.trim()
			? anomalyDetail(response.error, redactions)
			: "";
	return reason
		? {
				detail: `Pi rejected the prompt: ${reason}`,
				failure: { reason: "prompt_rejected", text: reason },
			}
		: {
				detail: "Pi rejected the prompt",
				failure: { reason: "prompt_rejected" },
			};
}
class PiRpcInstance implements HarnessInstance {
	/** Tool names by call ID, so tool_end can describe tool-specific outcomes. */
	private readonly toolNames = new Map<string, string>();
	readonly processId: ManagedProcess["id"];
	readonly exit: ManagedProcess["exit"];
	readonly control: HarnessControl = {
		getCommands: () => this.getCommands(),
		runCommand: (name, remainder, beforeDispatch) =>
			this.runCommand(name, remainder, beforeDispatch),
		getSelection: () => this.getControlSelection(),
		getStatus: () => this.getControlStatus(),
		listModels: () => this.listModels(),
		listEfforts: () => this.listEfforts(),
		setModel: (provider, modelId) => this.setModel(provider, modelId),
		setEffort: (level) => this.setEffort(level),
		reload: (beforeDispatch) => this.reload(beforeDispatch),
	};
	private readonly queue: HarnessEvent[] = [];
	private readonly waiters: ((result: IteratorResult<HarnessEvent>) => void)[] =
		[];
	private readonly pending = new Map<string, PendingCommand>();
	private readonly activeInputs = new Map<InputId, ActiveInput>();
	private costCommandPending = false;
	private costCommandQuarantined = false;
	private costResultWaiter?: CostResultWaiter;
	private abortInFlight?: AbortGate;
	private abortOutcomeUncertain = false;
	private nativeId?: string;
	private agentRunning = false;
	/** Pi reports any compaction (manual or automatic); reload waits for it. */
	private compacting = false;
	/** Pi reports manual compaction, the only kind during which it rejects prompts. */
	private manualCompaction = false;
	private reloadExtensionError = false;
	private reloadPending = false;
	private reloadDispatched = false;
	private reloadCommandVerified = false;
	private commands: HarnessCommand[] = [];
	private reloadTimedOut = false;
	private eventsClosed = false;
	private childExited = false;
	private stdoutEnded = false;
	private exitDrainTimer?: ReturnType<typeof setTimeout>;
	private exitDetail?: string;
	/** Exit code or signal of the child, once it exited. */
	private exitState?: string;
	/** Bounded Pi stderr tail; journal-only diagnostics, never forwarded or stored. */
	private stderrRaw = "";
	private stderrTruncated = false;
	private readonly stdoutEndWaiters: (() => void)[] = [];
	/** Partial stdout line, bounded by the record-size limit. */
	private buffer = "";
	private bufferBytes = 0;
	/** Set while discarding the rest of an oversized line; keeps only a bounded head. */
	private oversized?: { head: string; bytes: number; endsWithCr: boolean };
	/** Partial record left at stdout EOF, reported when the process stops. */
	private eofLeftover?: { bytes: number; head?: string; recordType?: string };
	private consecutiveAnomalies = 0;
	private readonly compactionWaiters: (() => void)[] = [];
	private writeChain: Promise<void> = Promise.resolve();
	private cleanup?: Promise<void>;
	private failureReported = false;
	private shuttingDown = false;
	constructor(
		private readonly child: ManagedProcess,
		private readonly sessionId: SessionId,
		private readonly options: PiRpcHarnessOptions,
		private readonly reloadCommand: string,
		private readonly fileSendBridge?: AgentFileSendBridge,
	) {
		this.processId = child.id;
		this.exit = child.exit;
		const stdin = child.stdin;
		const stdout = child.stdout;
		const stderr = child.stderr;
		if (!stdin || !stdout || !stderr)
			throw new Error("Pi RPC requires all pipe streams");
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk: string) => this.consume(chunk));
		stdout.on("error", () =>
			this.failProcess("Pi stdout failed", {
				reason: "channel_failed",
				channel: "stdout",
			}),
		);
		stdout.on("end", () => {
			this.stdoutEnded = true;
			for (const resolve of this.stdoutEndWaiters.splice(0)) resolve();
			this.keepEofLeftover();
			if (this.childExited) queueMicrotask(() => this.finalizeChildExit(false));
			else this.scheduleExitDrain();
		});
		stdin.on("error", () =>
			this.failProcess("Pi stdin failed", {
				reason: "channel_failed",
				channel: "stdin",
			}),
		);
		stderr.setEncoding("utf8");
		stderr.on("data", (chunk: string) => {
			const combined = this.stderrRaw + chunk;
			if (combined.length > STDERR_RAW_LIMIT) this.stderrTruncated = true;
			this.stderrRaw = combined.slice(-STDERR_RAW_LIMIT);
		});
		stderr.on("error", () =>
			this.failProcess("Pi stderr failed", {
				reason: "channel_failed",
				channel: "stderr",
			}),
		);
		void child.exit.then((exit) => {
			this.childExited = true;
			void this.fileSendBridge?.close().catch(() => {});
			if (this.eventsClosed) return;
			const state = exit.code ?? exit.signal;
			this.exitState = state === null ? undefined : String(state);
			this.exitDetail = `Pi process exited (${this.exitState ?? "unknown"})`;
			if (this.stdoutEnded) queueMicrotask(() => this.finalizeChildExit(false));
			else this.scheduleExitDrain();
		});
	}
	get nativeSessionId(): string | undefined {
		return this.nativeId;
	}
	diagnosticTail(): string | undefined {
		let raw = this.stderrRaw;
		if (this.stderrTruncated) {
			// Drop the partial first line so a cut-off secret cannot escape redaction.
			const newline = raw.indexOf("\n");
			if (newline >= 0) raw = raw.slice(newline + 1);
		}
		// Redact first, then bound, so truncation never splits an unredacted secret.
		const tail = redactDiagnosticText(raw, [this.fileSendBridge?.token])
			.slice(-STDERR_TAIL_LIMIT)
			.trim();
		return tail || undefined;
	}
	private async controlData(
		command: string,
		extra: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		let response: Record<string, unknown>;
		try {
			response = await this.command(command, extra);
		} catch (error) {
			throw new PiControlError("PI_CONTROL_FAILED", { cause: error });
		}
		const data = recordValue(response.data);
		if (response.success !== true || !data)
			throw new PiControlError("PI_CONTROL_FAILED");
		return data;
	}
	private async getControlSelection(): Promise<HarnessSelection> {
		const state = await this.controlData("get_state");
		const model =
			state.model === undefined ? undefined : modelInfo(state.model);
		if (state.model !== undefined && !model)
			throw new PiControlError("PI_CONTROL_FAILED");
		return {
			...(model ? { model } : {}),
			...(typeof state.thinkingLevel === "string"
				? { effort: state.thinkingLevel }
				: {}),
		};
	}
	private async getControlStatus(): Promise<HarnessLiveStatus> {
		const [selection, stats] = await Promise.all([
			this.getControlSelection(),
			this.controlData("get_session_stats"),
		]);
		const usage = usageStats(stats);
		return { ...selection, ...(usage ? { usage } : {}) };
	}
	private async listModels(): Promise<readonly HarnessModelInfo[]> {
		const data = await this.controlData("get_available_models");
		if (!Array.isArray(data.models))
			throw new PiControlError("PI_CONTROL_FAILED");
		const models = data.models.map(modelInfo);
		if (models.some((model) => model === undefined))
			throw new PiControlError("PI_CONTROL_FAILED");
		return models as HarnessModelInfo[];
	}
	private async listEfforts(): Promise<readonly string[]> {
		const data = await this.controlData("get_available_thinking_levels");
		if (
			!Array.isArray(data.levels) ||
			data.levels.some((level) => typeof level !== "string")
		)
			throw new PiControlError("PI_CONTROL_FAILED");
		return data.levels as string[];
	}
	private async setModel(
		provider: string,
		modelId: string,
	): Promise<HarnessModelInfo> {
		const available = await this.listModels();
		if (
			!available.some(
				(model) => model.provider === provider && model.id === modelId,
			)
		)
			throw new PiControlError("MODEL_NOT_AVAILABLE");
		const data = await this.controlData("set_model", { provider, modelId });
		const selected = modelInfo(data);
		if (!selected) throw new PiControlError("PI_CONTROL_FAILED");
		return selected;
	}
	private async setEffort(level: string): Promise<void> {
		const available = await this.listEfforts();
		if (!available.includes(level))
			throw new PiControlError("EFFORT_NOT_SUPPORTED");
		try {
			const response = await this.command("set_thinking_level", { level });
			if (response.success !== true)
				throw new PiControlError("PI_CONTROL_FAILED");
		} catch (error) {
			if (error instanceof PiControlError) throw error;
			throw new PiControlError("PI_CONTROL_FAILED", { cause: error });
		}
	}
	private async discoverCommands(): Promise<HarnessCommand[]> {
		try {
			const response = await this.command("get_commands");
			const listed = recordValue(response.data);
			if (response.success !== true || !Array.isArray(listed?.commands))
				throw new Error("Malformed command inventory");
			const seen = new Set<string>();
			const commands: HarnessCommand[] = [];
			for (const entry of listed.commands) {
				const command = commandInfo(entry);
				if (
					!command ||
					command.name === this.reloadCommand ||
					seen.has(command.name)
				)
					continue;
				seen.add(command.name);
				commands.push(command);
			}
			this.commands = commands;
			return commands;
		} catch (error) {
			throw new PiControlError("COMMAND_DISCOVERY_FAILED", { cause: error });
		}
	}
	private async getCommands(): Promise<readonly HarnessCommand[]> {
		return this.discoverCommands();
	}
	private async runCommand(
		name: string,
		remainder: string,
		beforeDispatch: () => boolean = () => true,
	): Promise<HarnessCommandResult> {
		if (this.reloadPending) throw new PiControlError("RELOAD_BUSY");
		if (
			!(await this.discoverCommands()).some((command) => command.name === name)
		)
			throw new PiControlError("COMMAND_NOT_AVAILABLE");
		const isCost = name === "cost";
		if (isCost && (this.costCommandPending || this.costCommandQuarantined))
			throw new PiControlError("COMMAND_UNCERTAIN");
		this.costCommandPending ||= isCost;
		const costWaiter = isCost ? this.waitForCostResult() : undefined;
		let dispatched = false;
		try {
			const response = await this.command(
				"prompt",
				{ message: `/${name}${remainder}` },
				undefined,
				false,
				false,
				async () => {
					while (this.abortInFlight) await this.abortInFlight.promise;
				},
				() => {
					if (this.eventsClosed || this.childExited || this.stdoutEnded)
						throw new Error("Pi process is closed");
					if (this.reloadPending) throw new PiControlError("RELOAD_BUSY");
					if (this.abortInFlight) throw new PiControlError("COMMAND_REJECTED");
					if (!beforeDispatch())
						throw new PiControlError("COMMAND_SELECTION_CHANGED");
					dispatched = true;
					if (costWaiter) {
						costWaiter.active = true;
						costWaiter.timer = setTimeout(() => {
							this.costCommandQuarantined = true;
							costWaiter.reject(new Error("Cost result unavailable"));
						}, this.options.commandTimeoutMs ?? 30_000);
					}
				},
			);
			const disposition = recordValue(response.data)?.disposition;
			if (response.success !== true)
				throw new PiControlError("COMMAND_REJECTED");
			if (isCost && disposition !== "handled")
				throw new PiControlError("COMMAND_UNCERTAIN");
			if (
				disposition !== "handled" &&
				!["started", "queued", "accepted"].includes(String(disposition))
			)
				throw new PiControlError("COMMAND_UNCERTAIN");
			const output = costWaiter ? await costWaiter.promise : undefined;
			return {
				disposition: disposition === "handled" ? "handled" : "accepted",
				...(output ? { output } : {}),
			};
		} catch (error) {
			if (isCost && dispatched) this.costCommandQuarantined = true;
			if (error instanceof PiControlError) throw error;
			throw new PiControlError(
				dispatched ? "COMMAND_UNCERTAIN" : "COMMAND_REJECTED",
				{ cause: error },
			);
		} finally {
			if (costWaiter) {
				if (costWaiter.timer) clearTimeout(costWaiter.timer);
				if (this.costResultWaiter === costWaiter)
					this.costResultWaiter = undefined;
				this.costCommandPending = false;
			}
		}
	}
	private waitForCostResult(): CostResultWaiter {
		let resolve!: (value: string) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<string>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		void promise.catch(() => {});
		const waiter: CostResultWaiter = {
			active: false,
			promise,
			resolve,
			reject,
		};
		this.costResultWaiter = waiter;
		return waiter;
	}
	private captureCostResult(value: unknown): void {
		const waiter = this.costResultWaiter;
		if (!waiter?.active) return;
		const message = recordValue(value);
		if (
			message?.role !== "custom" ||
			message.customType !== COST_REPORT_CUSTOM_TYPE
		)
			return;
		if (typeof message.content !== "string" || !message.content.trim()) {
			this.costCommandQuarantined = true;
			waiter.reject(new Error("Malformed cost result"));
			return;
		}
		waiter.resolve(
			truncateDiagnostic(redactDiagnosticText(message.content), 2000),
		);
	}
	private async reload(beforeDispatch?: () => void): Promise<void> {
		const validateDispatch = beforeDispatch ?? (() => {});
		if (
			this.reloadPending ||
			this.agentRunning ||
			this.compacting ||
			this.activeInputs.size > 0 ||
			this.abortInFlight
		)
			throw new PiControlError("RELOAD_BUSY");
		this.reloadPending = true;
		this.reloadTimedOut = false;
		try {
			if (!this.reloadCommandVerified)
				throw new PiControlError("PI_CONTROL_FAILED");
			this.reloadExtensionError = false;
			const response = await this.command(
				"prompt",
				{ message: `/${this.reloadCommand}` },
				undefined,
				true,
				true,
				undefined,
				() => {
					if (this.eventsClosed || this.childExited || this.stdoutEnded)
						throw new PiControlError("PI_CONTROL_FAILED");
					if (
						this.agentRunning ||
						this.compacting ||
						this.activeInputs.size > 0 ||
						this.abortInFlight
					)
						throw new PiControlError("RELOAD_BUSY");
					validateDispatch();
					this.reloadDispatched = true;
				},
			);
			const responseData = recordValue(response.data);
			if (
				response.success !== true ||
				responseData?.disposition !== "handled" ||
				this.reloadExtensionError
			)
				throw new PiControlError("PI_CONTROL_FAILED");
			try {
				await this.discoverCommands();
			} catch {
				this.commands = [];
			}
		} catch (error) {
			if (error instanceof PiControlError || error instanceof ReloadError)
				throw error;
			throw new PiControlError("PI_CONTROL_FAILED", { cause: error });
		} finally {
			if (!this.reloadTimedOut) {
				this.reloadPending = false;
				this.reloadDispatched = false;
			}
		}
	}
	get events(): AsyncIterable<HarnessEvent> {
		const self = this;
		return {
			[Symbol.asyncIterator]() {
				return { next: () => self.nextEvent() };
			},
		};
	}
	private nextEvent(): Promise<IteratorResult<HarnessEvent>> {
		const event = this.queue.shift();
		if (event) return Promise.resolve({ value: event, done: false });
		if (this.eventsClosed)
			return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	private emit(event: HarnessEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	private delivery(
		inputId: InputId,
		state: InputEvent["state"],
		detail?: string,
		failure?: InputFailure,
	): void {
		this.emit({
			sessionId: this.sessionId,
			kind: "input",
			inputEvent: {
				inputId,
				state,
				...(detail ? { detail } : {}),
				...(failure ? { failure } : {}),
			},
		});
	}
	/** Report a definite non-delivery with its English detail and fixed reason code. */
	private failInput(inputId: InputId, failed: InputNonDelivery): void {
		this.delivery(inputId, "failed", failed.detail, failed.failure);
	}
	private get maxRecordBytes(): number {
		return this.options.maxRecordBytes ?? 1024 * 1024;
	}
	/**
	 * Split stdout into LF-delimited records. A line over the record limit is not
	 * collected: only a bounded head is kept and the rest is discarded as it arrives.
	 */
	private consume(chunk: string): void {
		let start = 0;
		while (!this.eventsClosed) {
			const at = chunk.indexOf("\n", start);
			const piece = at < 0 ? chunk.slice(start) : chunk.slice(start, at);
			this.appendPiece(piece);
			if (at < 0) return;
			start = at + 1;
			const oversized = this.oversized;
			if (oversized) {
				this.oversized = undefined;
				// A trailing CR belongs to the delimiter, not the record.
				const bytes = oversized.bytes - (oversized.endsWithCr ? 1 : 0);
				try {
					this.handleOversized(oversized.head, bytes);
				} catch (error) {
					this.reportAnomaly({
						kind: "handler_error",
						action: "skipped",
						harnessRunning: true,
						bytes,
						recordType:
							safeToken(scanRecordHead(oversized.head).get("type")) ??
							"unknown",
						detail: anomalyDetail(
							error instanceof Error ? `${error.name}: ${error.message}` : "",
							this.redactions,
						),
					});
					// A harnessd bug says nothing about Pi's stream.
					this.consecutiveAnomalies = 0;
				}
				continue;
			}
			let line = this.buffer;
			this.buffer = "";
			this.bufferBytes = 0;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
	}
	private appendPiece(piece: string): void {
		if (!piece) return;
		const bytes = Buffer.byteLength(piece, "utf8");
		if (this.oversized) {
			this.oversized.bytes += bytes;
			this.oversized.endsWithCr = piece.endsWith("\r");
			return;
		}
		if (this.bufferBytes + bytes <= this.maxRecordBytes) {
			this.buffer += piece;
			this.bufferBytes += bytes;
			return;
		}
		// Over the limit: keep only a head for type/ID extraction and start discarding.
		const head =
			this.buffer.length >= OVERSIZED_HEAD_CHARS
				? this.buffer.slice(0, OVERSIZED_HEAD_CHARS)
				: this.buffer +
					piece.slice(0, OVERSIZED_HEAD_CHARS - this.buffer.length);
		this.oversized = {
			head,
			bytes: this.bufferBytes + bytes,
			endsWithCr: piece.endsWith("\r"),
		};
		this.buffer = "";
		this.bufferBytes = 0;
	}
	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.streamAnomaly("invalid_json", line);
			return;
		}
		const record = recordValue(parsed);
		if (!record || typeof record.type !== "string") {
			this.streamAnomaly("missing_type", line);
			return;
		}
		let valid: boolean;
		try {
			valid = this.record(record, line);
		} catch (error) {
			this.streamAnomaly("handler_error", line, {
				recordType: safeToken(record.type) ?? "unknown",
				detail: anomalyDetail(
					error instanceof Error ? `${error.name}: ${error.message}` : "",
					this.redactions,
				),
			});
			return;
		}
		if (valid) this.consecutiveAnomalies = 0;
	}
	private get redactions(): readonly (string | undefined)[] {
		return [this.fileSendBridge?.token];
	}
	private reportAnomaly(report: Omit<HarnessAnomaly, "ref">): void {
		if (this.eventsClosed) return;
		this.emit({
			sessionId: this.sessionId,
			kind: "anomaly",
			anomalyEvent: anomaly(report),
		});
	}
	/**
	 * Report a skipped or mishandled stdout record. Too many in a row mean the stream is
	 * corrupted, which is the only stream anomaly that still stops Pi.
	 */
	private streamAnomaly(
		kind: HarnessAnomaly["kind"],
		line: string,
		extra: Partial<HarnessAnomaly> = {},
		action: HarnessAnomaly["action"] = "skipped",
	): void {
		const head = scanRecordHead(line);
		const recordType = extra.recordType ?? safeToken(head.get("type"));
		this.reportAnomaly({
			kind,
			action,
			harnessRunning: true,
			bytes: Buffer.byteLength(line, "utf8"),
			head: anomalyText(line, this.redactions),
			...(recordType ? { recordType } : {}),
			...extra,
		});
		// A harnessd handling bug is not evidence of a corrupted Pi stream.
		if (kind === "handler_error") this.consecutiveAnomalies = 0;
		else this.countAnomaly();
	}
	private countAnomaly(): void {
		this.consecutiveAnomalies++;
		if (this.consecutiveAnomalies <= MAX_CONSECUTIVE_ANOMALIES) return;
		this.reportAnomaly({
			kind: "corrupted_stream",
			action: "stopped",
			harnessRunning: false,
		});
		this.protocolFailure(
			`Pi RPC stdout is corrupted: more than ${MAX_CONSECUTIVE_ANOMALIES} consecutive invalid records`,
			{ reason: "stream_corrupted" },
		);
	}
	/** Handle a line over the record limit from its bounded head only. */
	private handleOversized(headText: string, bytes: number): void {
		const head = scanRecordHead(headText);
		const type = safeToken(head.get("type"));
		let handled = false;
		let action: HarnessAnomaly["action"] = "skipped";
		let command: string | undefined;
		if (
			type &&
			[
				"agent_start",
				"agent_end",
				"agent_settled",
				"turn_start",
				"turn_end",
				"compaction_start",
				"compaction_end",
				"auto_compaction_start",
				"auto_compaction_end",
			].includes(type)
		) {
			const reason = safeToken(head.get("reason"));
			this.event({ type, ...(reason ? { reason } : {}) });
			handled = true;
		} else if (
			type === "tool_execution_end" &&
			typeof head.get("toolCallId") === "string"
		) {
			// Pi writes isError after the (large) result, so the outcome is usually
			// unknown here: report the tool as finished without claiming success.
			const toolCallId = head.get("toolCallId") as string;
			const isError = head.get("isError");
			const toolName =
				safeToken(head.get("toolName")) ?? this.toolNames.get(toolCallId);
			this.toolNames.delete(toolCallId);
			this.emit({
				sessionId: this.sessionId,
				kind: "activity",
				activityEvent: {
					type: "tool_end",
					toolCallId,
					...(typeof isError === "boolean" ? { failed: isError } : {}),
					...(toolName === "bash" && isError === true
						? { detail: "error" }
						: {}),
				},
			});
			handled = true;
		} else if (
			type === "message_end" &&
			head.get("message.role") === "assistant"
		) {
			this.event({ type, message: { role: "assistant" } });
			handled = true;
		} else if (type === "response" && typeof head.get("id") === "string") {
			const id = head.get("id") as string;
			const item = this.pending.get(id);
			command = safeToken(head.get("command")) ?? item?.command;
			if (item) {
				this.failPending(
					id,
					new Error(
						`Pi RPC ${item.command} response exceeded the record size limit`,
					),
				);
				action = "failed_command";
			}
			// A late response to a finished command is ignored as usual.
			handled = true;
		} else if (type === "message_end" || type === "message_update") {
			// Readable message events whose content is not needed here are dropped as handled.
			handled = type === "message_update" || head.has("message.role");
		}
		if (handled && action === "skipped" && type !== "response")
			action = "handled";
		this.reportAnomaly({
			kind: "oversized_record",
			action,
			harnessRunning: true,
			bytes,
			...(type ? { recordType: type } : {}),
			...(command ? { command } : {}),
		});
		if (handled) this.consecutiveAnomalies = 0;
		else this.countAnomaly();
	}
	/** Fail one pending command without touching the process. */
	private failPending(id: string, error: Error): void {
		const item = this.pending.get(id);
		if (!item) return;
		this.pending.delete(id);
		if (item.timer) clearTimeout(item.timer);
		if (item.isReload) {
			this.reloadPending = false;
			this.reloadDispatched = false;
			this.reloadTimedOut = false;
		}
		item.reject(error);
	}
	/** Keep (bounded) any partial record left at stdout EOF; reported when Pi stops. */
	private keepEofLeftover(): void {
		const oversized = this.oversized;
		const kept = oversized?.head ?? this.buffer;
		const recordType = kept
			? safeToken(scanRecordHead(kept).get("type"))
			: undefined;
		if (oversized)
			this.eofLeftover = {
				bytes: oversized.bytes,
				...(recordType ? { recordType } : {}),
			};
		else if (this.buffer.length)
			this.eofLeftover = {
				bytes: this.bufferBytes,
				head: anomalyText(this.buffer, this.redactions),
				...(recordType ? { recordType } : {}),
			};
		this.oversized = undefined;
		this.buffer = "";
		this.bufferBytes = 0;
	}
	private scheduleExitDrain(): void {
		if (this.eventsClosed || this.exitDrainTimer) return;
		this.exitDrainTimer = setTimeout(
			() => this.finalizeChildExit(true),
			this.options.exitDrainTimeoutMs ?? 1000,
		);
	}
	private finalizeChildExit(drainTimedOut: boolean): void {
		if (this.eventsClosed) return;
		if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
		this.exitDrainTimer = undefined;
		if (this.childExited && this.stdoutEnded) {
			if (this.shuttingDown) this.closeEvents("Pi harness shut down");
			else
				this.closeEvents(this.exitDetail ?? "Pi process exited", {
					reason: "process_exited",
					...(this.exitState ? { exit: this.exitState } : {}),
				});
			return;
		}
		if (!drainTimedOut) return;
		if (this.childExited)
			this.failProcess("Pi stdout did not close after process exit", {
				reason: "stdout_not_closed",
			});
		else
			this.failProcess("Pi stdout closed before process exit", {
				reason: "stdout_closed_early",
			});
	}
	private waitForStdoutEnd(): Promise<void> {
		if (this.stdoutEnded) return Promise.resolve();
		return new Promise((resolve) => this.stdoutEndWaiters.push(resolve));
	}
	private protocolFailure(text: string, stop: HarnessStop): void {
		if (this.failureReported) return;
		this.failureReported = true;
		this.emit({
			sessionId: this.sessionId,
			kind: "error",
			text,
			fatal: true,
			stop,
		});
		this.failProcess("Malformed Pi RPC protocol");
	}
	/**
	 * Apply one parsed record. Returns false when the record was an anomaly (reported
	 * here); throws only on a harnessd handling bug, which the caller reports.
	 */
	private record(record: Record<string, unknown>, line: string): boolean {
		if (this.eventsClosed) return true;
		if (record.type === "response") return this.response(record, line);
		this.event(record);
		return true;
	}
	private response(record: Record<string, unknown>, line: string): boolean {
		const command = safeToken(record.command);
		if (typeof record.id !== "string") {
			// For example Pi's id-less `parse` error for a line it could not read.
			this.streamAnomaly("response_without_id", line, {
				...(command ? { command } : {}),
				...(typeof record.error === "string"
					? { detail: anomalyDetail(record.error, this.redactions) }
					: {}),
			});
			return false;
		}
		const item = this.pending.get(record.id);
		if (!item) return true;
		if (
			typeof record.command !== "string" ||
			typeof record.success !== "boolean"
		) {
			this.failPending(
				record.id,
				new Error(`Malformed Pi RPC ${item.command} response`),
			);
			this.streamAnomaly(
				"malformed_response",
				line,
				{ command: item.command },
				"failed_command",
			);
			return false;
		}
		if (record.command !== item.command) {
			this.failPending(
				record.id,
				new Error(`Pi RPC ${item.command} response named another command`),
			);
			this.streamAnomaly(
				"response_mismatch",
				line,
				{
					command: item.command,
					...(command ? { detail: `Pi answered as ${command}` } : {}),
				},
				"failed_command",
			);
			return false;
		}
		this.pending.delete(record.id);
		if (item.timer) clearTimeout(item.timer);
		if (item.isReload) {
			this.reloadPending = false;
			this.reloadDispatched = false;
		}
		if (item.command === "prompt")
			this.applyPromptResponse(record, item.inputId);
		else if (item.command === "abort")
			this.applyAbortResponse(record, item.inputId);
		item.resolve(record);
		return true;
	}
	private event(record: Record<string, unknown>): void {
		if (typeof record.type !== "string") return;
		if (record.type === "message_start") {
			this.captureCostResult(record.message);
			return;
		}
		if (record.type === "message_end") {
			const notice = subagentNotice(record.message);
			if (notice)
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: { type: "agent_notice", text: notice },
				});
			// Message boundaries let transports deliver each answer before the run settles.
			if (
				(record.message as Record<string, unknown> | undefined)?.role ===
				"assistant"
			)
				this.emit({
					sessionId: this.sessionId,
					kind: "status",
					text: "message_end",
				});
			return;
		}
		if (record.type === "extension_error") {
			if (this.reloadDispatched) {
				this.reloadExtensionError = true;
				return;
			}
			const extensionPath =
				typeof record.extensionPath === "string"
					? path.basename(record.extensionPath)
					: undefined;
			const eventName =
				typeof record.event === "string" ? record.event : undefined;
			const detail =
				typeof record.error === "string"
					? record.error
					: record.error === undefined
						? "Unknown extension error"
						: JSON.stringify(record.error);
			this.emit({
				sessionId: this.sessionId,
				kind: "error",
				text: redactDiagnosticText(
					`Pi extension${extensionPath ? ` ${extensionPath}` : ""}${eventName ? ` (${eventName})` : ""}: ${detail}`,
				),
			});
			return;
		}
		if (record.type === "extension_ui_request") {
			const method =
				typeof record.method === "string" ? record.method : "unknown";
			if (method === "notify") {
				if (typeof record.message === "string")
					this.emit({
						sessionId: this.sessionId,
						kind: "activity",
						activityEvent: {
							type: "notification",
							text: redactDiagnosticText(record.message),
							...(typeof record.notifyType === "string"
								? { level: record.notifyType }
								: {}),
						},
					});
				return;
			}
			if (method === "setStatus") {
				if (typeof record.statusText === "string")
					this.emit({
						sessionId: this.sessionId,
						kind: "activity",
						activityEvent: {
							type: "notification",
							text: redactDiagnosticText(record.statusText),
							level: "status",
						},
					});
				return;
			}
			// Title and editor-text requests have no Telegram counterpart; ignore them silently.
			if (method === "setTitle" || method === "set_editor_text") return;
			if (method === "setWidget") {
				const lines = Array.isArray(record.widgetLines)
					? record.widgetLines.filter(
							(line): line is string => typeof line === "string",
						)
					: [];
				const widgetKey =
					typeof record.widgetKey === "string" ? record.widgetKey : undefined;
				// An empty keyed widget is a clear; transports drop what it showed.
				if (lines.length || widgetKey)
					this.emit({
						sessionId: this.sessionId,
						kind: "activity",
						activityEvent: {
							type: "notification",
							text: redactDiagnosticText(lines.join("\n")),
							level: "status",
							...(widgetKey ? { widgetKey } : {}),
						},
					});
				return;
			}
			const dialogMethods = ["select", "confirm", "input", "editor"];
			const title = typeof record.title === "string" ? record.title : undefined;
			const message =
				typeof record.message === "string" ? record.message : undefined;
			if (dialogMethods.includes(method) && typeof record.id === "string") {
				this.emit({
					sessionId: this.sessionId,
					kind: "error",
					text: redactDiagnosticText(
						`Pi extension requested unsupported ${method} dialog${title ? `: ${title}` : ""}${message ? ` — ${message}` : ""}. The dialog was cancelled because Telegram dialog forwarding is not available.`,
					),
				});
				void this.write({
					type: "extension_ui_response",
					id: record.id,
					cancelled: true,
				}).catch(() => {});
				return;
			}
			this.emit({
				sessionId: this.sessionId,
				kind: "error",
				text: redactDiagnosticText(
					`Unsupported Pi extension UI request: ${method}`,
				),
			});
			return;
		}
		if (record.type === "message_update") {
			const update = record.assistantMessageEvent as
				| Record<string, unknown>
				| undefined;
			if (update?.type === "text_delta" && typeof update.delta === "string")
				this.emit({
					sessionId: this.sessionId,
					kind: "output",
					text: update.delta,
				});
			else if (
				update?.type === "thinking_start" ||
				update?.type === "thinking_end"
			) {
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "thinking",
						active: update.type === "thinking_start",
					},
				});
				const thought =
					update.type === "thinking_end" && typeof update.content === "string"
						? thoughtSummary(update.content)
						: undefined;
				if (thought)
					this.emit({
						sessionId: this.sessionId,
						kind: "activity",
						activityEvent: { type: "thought", text: thought },
					});
			}
			return;
		}
		if (record.type === "tool_execution_start") {
			if (
				typeof record.toolCallId === "string" &&
				typeof record.toolName === "string"
			) {
				this.toolNames.set(record.toolCallId, record.toolName);
				if (this.toolNames.size > 512)
					this.toolNames.delete(this.toolNames.keys().next().value as string);
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "tool_start",
						toolCallId: record.toolCallId,
						summary: toolActivitySummary(record.toolName, record.args),
					},
				});
			}
			return;
		}
		if (record.type === "entry_appended") {
			const task = taskActivity(record.entry);
			if (task)
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: task,
				});
			return;
		}
		if (record.type === "tool_execution_end") {
			if (typeof record.toolCallId === "string") {
				const toolName =
					typeof record.toolName === "string"
						? record.toolName
						: this.toolNames.get(record.toolCallId);
				this.toolNames.delete(record.toolCallId);
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "tool_end",
						toolCallId: record.toolCallId,
						failed: record.isError === true,
						...(toolName === "bash"
							? {
									detail: bashExitDetail(
										record.result,
										record.isError === true,
									),
								}
							: {}),
					},
				});
			}
			return;
		}
		if (["auto_compaction_start", "compaction_start"].includes(record.type)) {
			this.compacting = true;
			// Pi 1.3 marks manual compaction with reason "manual"; older Pi used
			// auto_compaction_* for automatic compaction and no reason.
			this.manualCompaction =
				record.type === "compaction_start" &&
				(record.reason === undefined || record.reason === "manual");
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: "compaction_start",
			});
		}
		if (["auto_compaction_end", "compaction_end"].includes(record.type)) {
			this.endCompaction();
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: "compaction_end",
			});
		}
		if (["agent_start", "agent_end", "agent_settled"].includes(record.type)) {
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: record.type,
			});
			if (record.type === "agent_start") this.agentRunning = true;
			if (record.type === "agent_settled") {
				this.agentRunning = false;
				// Settlement for an aborting run says nothing about native queued inputs.
				for (const input of this.activeInputs.values()) {
					// A held input has not been sent, so this run says nothing about it.
					if (input.held) continue;
					if (this.abortInFlight && !input.canceling) continue;
					if (input.accepted || !input.sentAsSteer) input.settled = true;
					if (input.uncertain) this.activeInputs.delete(input.id);
					else if (input.accepted && input.settled && !input.canceling)
						this.completeActive(input.id);
				}
				if (this.abortOutcomeUncertain) this.releaseAbortGate();
			}
		}
	}
	private applyPromptResponse(
		response: Record<string, unknown>,
		inputId?: InputId,
	): void {
		if (inputId === undefined) return;
		const active = this.activeInputs.get(inputId);
		if (!active) return;
		if (response.success !== true) {
			this.activeInputs.delete(active.id);
			const rejected = promptRejection(response, this.redactions);
			this.reportAnomaly({
				kind: "prompt_rejected",
				action: "failed_input",
				harnessRunning: true,
				...(typeof response.error === "string"
					? { detail: anomalyDetail(response.error, this.redactions) }
					: {}),
			});
			this.failInput(active.id, rejected);
			return;
		}
		active.accepted = true;
		this.delivery(active.id, "accepted");
		const disposition = (response.data as Record<string, unknown> | undefined)
			?.disposition;
		if (disposition === "handled") active.settled = true;
		if (active.settled && !active.canceling) this.completeActive(active.id);
	}
	private applyAbortResponse(
		response: Record<string, unknown>,
		inputId?: InputId,
	): void {
		if (inputId === undefined) return;
		const active = this.activeInputs.get(inputId);
		if (!active?.canceling) return;
		if (response.success === true) {
			this.activeInputs.delete(active.id);
			this.failInput(active.id, nonDelivery("canceled"));
			return;
		}
		active.canceling = false;
		if (active.settled) this.completeActive(active.id);
	}
	private write(
		value: Record<string, unknown>,
		beforeWrite?: () => void | Promise<void>,
		validateWrite?: () => void,
	): Promise<void> {
		const line = `${JSON.stringify(value)}\n`;
		const operation = this.writeChain.then(async () => {
			const stdin = this.child.stdin as Writable;
			if (stdin.destroyed || stdin.writableEnded)
				throw new Error("Pi stdin is closed");
			await beforeWrite?.();
			validateWrite?.();
			if (!stdin.write(line))
				await new Promise<void>((resolve, reject) => {
					const done = () => {
						stdin.off("error", onError);
						resolve();
					};
					const onError = (error: Error) => {
						stdin.off("drain", done);
						reject(error);
					};
					stdin.once("drain", done);
					stdin.once("error", onError);
				});
		});
		this.writeChain = operation.catch(() => {});
		return operation;
	}
	private async command(
		command: string,
		extra: Record<string, unknown> = {},
		inputId?: InputId,
		retainAfterTimeout = false,
		isReload = false,
		beforeWrite?: () => void | Promise<void>,
		onWrite?: () => void,
	): Promise<Record<string, unknown>> {
		if (this.eventsClosed) throw new Error("Pi process is closed");
		const id = randomUUID();
		let resolveResponse!: (record: Record<string, unknown>) => void;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		let writeCancelled = false;
		let writeStarted = false;
		const pending: PendingCommand = {
			command,
			...(inputId !== undefined ? { inputId } : {}),
			...(retainAfterTimeout ? { retainAfterTimeout } : {}),
			...(isReload ? { isReload } : {}),
			resolve: resolveResponse,
			reject: rejectResponse,
		};
		pending.timer = setTimeout(() => {
			if (!writeStarted) writeCancelled = true;
			if (!pending.retainAfterTimeout) this.pending.delete(id);
			if (pending.isReload) this.reloadTimedOut = true;
			rejectResponse(new Error(`Pi RPC ${command} timed out`));
		}, this.options.commandTimeoutMs ?? 30_000);
		this.pending.set(id, pending);
		void response.catch(() => {});
		try {
			const write = this.write(
				{
					id,
					type: command,
					...extra,
				},
				async () => {
					if (writeCancelled)
						throw new Error("Pi RPC command expired before write");
					await beforeWrite?.();
					if (writeCancelled)
						throw new Error("Pi RPC command expired before write");
				},
				() => {
					if (writeCancelled)
						throw new Error("Pi RPC command expired before write");
					onWrite?.();
					writeStarted = true;
				},
			);
			if (pending.isReload) {
				void write.catch(() => {
					if (this.reloadDispatched) return;
					this.pending.delete(id);
					if (pending.timer) clearTimeout(pending.timer);
					this.reloadPending = false;
					this.reloadDispatched = false;
					this.reloadTimedOut = false;
				});
			}
			await within(
				write,
				this.options.commandTimeoutMs ?? 30_000,
				`Pi RPC ${command} write timed out`,
			);
		} catch (error) {
			writeCancelled = true;
			if (!pending.retainAfterTimeout || error instanceof ReloadError)
				this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.isReload && !(error instanceof ReloadError))
				this.reloadTimedOut = true;
			rejectResponse(error as Error);
			throw error;
		}
		return response;
	}
	async ready(expectedSessionId?: string): Promise<string> {
		const response = await within(
			this.command("get_state"),
			this.options.startupTimeoutMs ?? 15_000,
			"Pi RPC startup timed out",
		);
		const sessionId = (response.data as Record<string, unknown> | undefined)
			?.sessionId;
		if (
			response.success !== true ||
			typeof sessionId !== "string" ||
			!sessionId
		)
			throw new Error("Pi RPC get_state returned no session ID");
		if (expectedSessionId !== undefined && sessionId !== expectedSessionId)
			throw new Error("Pi RPC resumed a different native session");
		const listed = await within(
			this.command("get_commands"),
			this.options.startupTimeoutMs ?? 15_000,
			"Pi command discovery timed out",
		);
		const data = recordValue(listed.data);
		const commands = Array.isArray(data?.commands) ? data.commands : [];
		const matches = commands.filter((entry) => {
			const command = recordValue(entry);
			return (
				command?.name === this.reloadCommand &&
				command.source === "extension" &&
				command.description === RELOAD_COMMAND_DESCRIPTION
			);
		});
		if (listed.success !== true || matches.length !== 1)
			throw new PiStartupError("PI_STARTUP_FAILED");
		const seen = new Set<string>();
		this.commands = commands.flatMap((entry) => {
			const command = commandInfo(entry);
			if (
				!command ||
				command.name === this.reloadCommand ||
				seen.has(command.name)
			)
				return [];
			seen.add(command.name);
			return [command];
		});
		this.reloadCommandVerified = true;
		this.nativeId = sessionId;
		return sessionId;
	}
	async send(input: Input): Promise<void> {
		while (this.abortInFlight) await this.abortInFlight.promise;
		if (this.eventsClosed) throw new Error("Pi harness is closed");
		if (this.reloadPending) throw new PiControlError("RELOAD_BUSY");
		const active: ActiveInput = {
			id: input.id,
			sentAsSteer: false,
			accepted: false,
			settled: false,
			uncertain: false,
			uncertainReported: false,
			canceling: false,
		};
		this.activeInputs.set(input.id, active);
		this.delivery(input.id, "pending");
		if (this.manualCompaction) {
			await this.holdDuringCompaction(active);
			// An abort that started while the prompt was held still gates it.
			await this.waitForAbortGate();
			if (this.eventsClosed)
				throw notDeliveredError(input.id, "held_and_stopped");
		}
		active.sentAsSteer = this.agentRunning || this.activeInputs.size > 1;
		let response: Record<string, unknown>;
		try {
			response = await this.command(
				"prompt",
				{
					message: input.text,
					// Always steer: Pi ignores it when idle, and a prompt racing an unseen
					// agent_start is then queued instead of rejected.
					streamingBehavior: "steer",
					...(input.images?.length
						? {
								images: input.images.map((image) => ({
									type: "image",
									data: image.data,
									mimeType: image.mimeType,
								})),
							}
						: {}),
				},
				input.id,
			);
		} catch (error) {
			const pendingInput = this.activeInputs.get(input.id);
			if (pendingInput) {
				pendingInput.uncertain = true;
				pendingInput.uncertainReported = true;
				this.delivery(
					input.id,
					"uncertain",
					"Pi prompt response was not received",
				);
				if (pendingInput.settled) this.activeInputs.delete(input.id);
			}
			throw new UncertainInputDeliveryError(input.id, { cause: error });
		}
		if (response.success !== true) {
			const rejected = promptRejection(response, this.redactions);
			throw new InputNotDeliveredError(
				input.id,
				rejected.detail,
				rejected.failure,
			);
		}
	}
	/**
	 * Pi rejects prompts during manual compaction, so hold this one until it ends.
	 * The hold is bounded: on timeout Pi's state is rechecked once and the input is sent
	 * if compaction has in fact ended (a lost end event); otherwise, and on cancel or
	 * process stop, the input fails without being sent. The input stays held until the
	 * recheck finishes, so a cancel or stop in that window still finds it held.
	 */
	private async holdDuringCompaction(active: ActiveInput): Promise<void> {
		this.reportAnomaly({
			kind: "prompt_held",
			action: "held_prompt",
			harnessRunning: true,
		});
		let outcome = await this.waitForCompactionEnd(active);
		if (outcome === "timeout" && !this.eventsClosed) {
			let canceled = false;
			active.held = (heldOutcome) => {
				if (heldOutcome === "canceled") canceled = true;
			};
			let stillCompacting = true;
			try {
				const state = await this.command("get_state");
				stillCompacting = recordValue(state.data)?.isCompacting !== false;
			} catch {
				/* unknown: keep failing safe */
			} finally {
				active.held = undefined;
			}
			// A lost end event: Pi says it is idle, so stop waiting for it.
			if (!stillCompacting) this.endCompaction();
			if (canceled) outcome = "canceled";
			else if (!this.manualCompaction) outcome = "ended";
		}
		// A stop already reported the held input as not sent; send() throws for it.
		if (outcome === "ended" || this.eventsClosed) return;
		this.activeInputs.delete(active.id);
		if (outcome === "canceled") {
			this.failInput(active.id, nonDelivery("canceled"));
			throw notDeliveredError(active.id, "canceled");
		}
		this.reportAnomaly({
			kind: "prompt_hold_timeout",
			action: "failed_input",
			harnessRunning: true,
		});
		this.failInput(active.id, nonDelivery("hold_timeout"));
		throw notDeliveredError(active.id, "hold_timeout");
	}
	private async waitForCompactionEnd(
		active: ActiveInput,
	): Promise<"ended" | "timeout" | "canceled"> {
		let release!: () => void;
		let finish!: (outcome: "ended" | "timeout" | "canceled") => void;
		const outcome = new Promise<"ended" | "timeout" | "canceled">((resolve) => {
			finish = resolve;
			release = () => resolve("ended");
		});
		this.compactionWaiters.push(release);
		active.held = finish;
		const timer = setTimeout(
			() => finish("timeout"),
			this.options.compactionHoldTimeoutMs ?? 300_000,
		);
		try {
			return await outcome;
		} finally {
			clearTimeout(timer);
			active.held = undefined;
			const waiter = this.compactionWaiters.indexOf(release);
			if (waiter >= 0) this.compactionWaiters.splice(waiter, 1);
		}
	}
	private endCompaction(): void {
		this.compacting = false;
		this.manualCompaction = false;
		this.releaseCompactionWaiters();
	}
	private async waitForAbortGate(): Promise<void> {
		while (this.abortInFlight) await this.abortInFlight.promise;
	}
	private releaseCompactionWaiters(): void {
		for (const release of this.compactionWaiters.splice(0)) release();
	}
	private completeActive(inputId: InputId): void {
		const active = this.activeInputs.get(inputId);
		if (!active) return;
		this.activeInputs.delete(inputId);
		this.delivery(active.id, "completed");
	}
	async cancelCurrent(): Promise<void> {
		const inputs = [...this.activeInputs.values()];
		const held = inputs.filter((input) => input.held);
		// With nothing sent, the current input is the one waiting for compaction.
		if (held.length === 1 && held.length === inputs.length) {
			await this.cancelInput((held[0] as ActiveInput).id, true);
			return;
		}
		// Pi aborts its whole run, so any acknowledged input can carry the abort;
		// prefer the one that started the run.
		const acknowledged = inputs.filter(
			(input) => !input.held && input.accepted && !input.uncertain,
		);
		const current =
			acknowledged.find((input) => !input.sentAsSteer) ?? acknowledged[0];
		if (!current) throw new Error("Pi has no acknowledged input to cancel");
		await this.cancelInput(current.id, true);
	}
	async cancel(inputId: InputId): Promise<void> {
		await this.cancelInput(inputId, false);
	}
	private async cancelInput(
		inputId: InputId,
		preserveQueued: boolean,
	): Promise<void> {
		if (this.reloadPending) throw new PiControlError("RELOAD_BUSY");
		const active = this.activeInputs.get(inputId);
		if (!active) throw new Error("Input is not active");
		if (active.held) {
			// Not yet sent to Pi: cancelling only ends the hold; send() reports it.
			active.held("canceled");
			return;
		}
		if (!preserveQueued && this.activeInputs.size > 1)
			throw new Error(
				"Pi cannot cancel one input while others are queued; no input was canceled",
			);
		if (!active.accepted || active.uncertain)
			throw new Error("Input cannot be canceled before acknowledged delivery");
		if (active.canceling)
			throw new Error("Input cancellation is already in progress");
		active.canceling = true;
		let releaseAbort!: () => void;
		const abortGate: AbortGate = {
			promise: new Promise<void>((resolve) => {
				releaseAbort = resolve;
			}),
			release: () => releaseAbort(),
		};
		this.abortInFlight = abortGate;
		this.abortOutcomeUncertain = false;
		let holdAbortGate = false;
		try {
			let response: Record<string, unknown>;
			try {
				response = await this.command("abort", {}, inputId);
			} catch (error) {
				const current = this.activeInputs.get(inputId);
				if (current) {
					current.uncertain = true;
					current.uncertainReported = true;
					if (!current.settled && !this.eventsClosed) {
						this.abortOutcomeUncertain = true;
						holdAbortGate = true;
					}
					this.delivery(
						inputId,
						"uncertain",
						"Pi abort response was not received",
					);
					if (current.settled) this.activeInputs.delete(inputId);
				}
				throw error;
			}
			if (response.success !== true) {
				const current = this.activeInputs.get(inputId);
				if (current) {
					current.canceling = false;
					if (current.settled) this.completeActive(inputId);
				}
				throw new Error("Pi rejected the abort command");
			}
			if (this.activeInputs.has(inputId)) {
				this.activeInputs.delete(inputId);
				this.failInput(inputId, nonDelivery("canceled"));
			}
		} finally {
			if (!holdAbortGate) this.releaseAbortGate(abortGate);
		}
	}
	private releaseAbortGate(expected?: AbortGate): void {
		const gate = this.abortInFlight;
		if (!gate || (expected && gate !== expected)) return;
		this.abortInFlight = undefined;
		this.abortOutcomeUncertain = false;
		gate.release();
	}
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.cleanup) return this.cleanup;
		this.cleanup = (async () => {
			if (!this.childExited)
				await terminateChild(
					this.child,
					this.options.shutdownTimeoutMs ?? 1000,
				);
			this.childExited = true;
			if (!this.stdoutEnded) {
				try {
					await within(
						this.waitForStdoutEnd(),
						this.options.exitDrainTimeoutMs ?? 1000,
						"Pi stdout drain timed out during shutdown",
					);
				} catch {
					this.closeEvents("Pi stdout did not drain during shutdown");
					throw new Error("Pi stdout did not drain during shutdown");
				}
			}
			this.closeEvents("Pi harness shut down");
			await this.fileSendBridge?.close();
		})();
		return this.cleanup;
	}
	private failProcess(detail: string, stop?: HarnessStop): void {
		if (!this.eventsClosed) this.closeEvents(detail, stop);
		if (!this.childExited && !this.cleanup) {
			const cleanup = terminateChild(
				this.child,
				this.options.shutdownTimeoutMs ?? 1000,
			).then(() => {
				this.childExited = true;
			});
			this.cleanup = cleanup;
			void cleanup.catch(() => {});
		}
	}
	private closeEvents(detail: string, stop?: HarnessStop): void {
		if (this.eventsClosed) return;
		const leftover = this.eofLeftover;
		this.eofLeftover = undefined;
		if (leftover)
			// A record cut by the process stopping is reported as that stop, not as malformed input.
			this.reportAnomaly({
				kind: "truncated_record",
				action: "skipped",
				harnessRunning: false,
				bytes: leftover.bytes,
				...(this.shuttingDown ? { stopRequested: true } : {}),
				...(leftover.recordType ? { recordType: leftover.recordType } : {}),
				...(leftover.head ? { head: leftover.head } : {}),
				detail: anomalyDetail(
					this.shuttingDown
						? "Pi harness shut down"
						: (this.exitDetail ?? detail),
					this.redactions,
				),
			});
		this.eventsClosed = true;
		this.releaseCompactionWaiters();
		this.reloadPending = false;
		this.reloadDispatched = false;
		this.reloadTimedOut = false;
		this.releaseAbortGate();
		if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
		this.exitDrainTimer = undefined;
		for (const active of this.activeInputs.values()) {
			if (active.held)
				// A held prompt was never written, so its failure is definite.
				this.failInput(active.id, nonDelivery("held_and_stopped"));
			else if (!active.uncertainReported)
				this.delivery(active.id, "uncertain", detail);
		}
		this.activeInputs.clear();
		for (const [id, item] of this.pending) {
			if (item.timer) clearTimeout(item.timer);
			item.reject(new Error(detail));
			this.pending.delete(id);
		}
		if (!this.failureReported && detail !== "Pi harness shut down") {
			this.failureReported = true;
			this.emit({
				sessionId: this.sessionId,
				kind: "error",
				text: redactDiagnosticText(detail),
				fatal: true,
				...(stop ? { stop } : {}),
			});
		}
		for (const waiter of this.waiters.splice(0))
			waiter({ value: undefined, done: true });
	}
}
