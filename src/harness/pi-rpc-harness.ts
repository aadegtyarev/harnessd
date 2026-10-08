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
	HarnessEvent,
	Input,
	InputEvent,
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

export interface PiRpcHarnessOptions {
	readonly executable: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly agentFileSend?: AgentFileSendHandler;
	readonly startupTimeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly exitDrainTimeoutMs?: number;
	readonly maxRecordBytes?: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const RELOAD_COMMAND_ENV = "HARNESSD_PI_RELOAD_COMMAND";
const RELOAD_COMMAND_DESCRIPTION = "harnessd internal reload command";

export class UncertainInputDeliveryError extends Error {
	readonly code = "UNCERTAIN_INPUT_DELIVERY";
	constructor(
		readonly inputId: InputId,
		options?: ErrorOptions,
	) {
		super("Input delivery is uncertain", options);
		this.name = "UncertainInputDeliveryError";
	}
}

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
		return { id: "pi-rpc" as AdapterId, capabilities };
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
			throw toPiStartupError(error, "ready");
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
interface ActiveInput {
	id: InputId;
	sentAsSteer: boolean;
	accepted: boolean;
	settled: boolean;
	uncertain: boolean;
	uncertainReported: boolean;
	canceling: boolean;
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
class PiRpcInstance implements HarnessInstance {
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
	private abortInFlight?: AbortGate;
	private abortOutcomeUncertain = false;
	private nativeId?: string;
	private agentRunning = false;
	private compacting = false;
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
	private readonly stdoutEndWaiters: (() => void)[] = [];
	private buffer = "";
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
		stdout.on("error", () => this.failProcess("Pi stdout failed"));
		stdout.on("end", () => {
			this.stdoutEnded = true;
			for (const resolve of this.stdoutEndWaiters.splice(0)) resolve();
			if (this.buffer.length) this.protocolFailure();
			else if (this.childExited)
				queueMicrotask(() => this.finalizeChildExit(false));
			else this.scheduleExitDrain();
		});
		stdin.on("error", () => this.failProcess("Pi stdin failed"));
		stderr.on("data", () => {});
		stderr.on("error", () => this.failProcess("Pi stderr failed"));
		void child.exit.then((exit) => {
			this.childExited = true;
			void this.fileSendBridge?.close().catch(() => {});
			if (this.eventsClosed) return;
			this.exitDetail = `Pi process exited (${exit.code ?? exit.signal ?? "unknown"})`;
			if (this.stdoutEnded) queueMicrotask(() => this.finalizeChildExit(false));
			else this.scheduleExitDrain();
		});
	}
	get nativeSessionId(): string | undefined {
		return this.nativeId;
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
				},
			);
			const disposition = recordValue(response.data)?.disposition;
			if (response.success !== true)
				throw new PiControlError("COMMAND_REJECTED");
			if (disposition === "handled") return "handled";
			if (["started", "queued", "accepted"].includes(String(disposition)))
				return "accepted";
			throw new PiControlError("COMMAND_UNCERTAIN");
		} catch (error) {
			if (error instanceof PiControlError) throw error;
			throw new PiControlError(
				dispatched ? "COMMAND_UNCERTAIN" : "COMMAND_REJECTED",
				{ cause: error },
			);
		}
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
	): void {
		this.emit({
			sessionId: this.sessionId,
			kind: "input",
			inputEvent: { inputId, state, ...(detail ? { detail } : {}) },
		});
	}
	private consume(chunk: string): void {
		if (this.eventsClosed) return;
		this.buffer += chunk;
		for (;;) {
			const at = this.buffer.indexOf("\n");
			if (at < 0) break;
			let line = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (
				Buffer.byteLength(line, "utf8") >
				(this.options.maxRecordBytes ?? 1024 * 1024)
			) {
				this.protocolFailure();
				return;
			}
			try {
				this.record(JSON.parse(line) as Record<string, unknown>);
			} catch {
				this.protocolFailure();
				return;
			}
			if (this.eventsClosed) return;
		}
		if (
			Buffer.byteLength(this.buffer, "utf8") >
			(this.options.maxRecordBytes ?? 1024 * 1024)
		)
			this.protocolFailure();
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
		if (this.buffer.length) {
			this.protocolFailure();
			return;
		}
		if (this.childExited && this.stdoutEnded) {
			if (this.shuttingDown) this.closeEvents("Pi harness shut down");
			else this.closeEvents(this.exitDetail ?? "Pi process exited");
			return;
		}
		if (!drainTimedOut) return;
		const detail = this.childExited
			? "Pi stdout did not close after process exit"
			: "Pi stdout closed before process exit";
		this.failProcess(detail);
	}
	private waitForStdoutEnd(): Promise<void> {
		if (this.stdoutEnded) return Promise.resolve();
		return new Promise((resolve) => this.stdoutEndWaiters.push(resolve));
	}
	private protocolFailure(): void {
		if (this.failureReported) return;
		this.failureReported = true;
		this.emit({
			sessionId: this.sessionId,
			kind: "error",
			text: "Malformed or oversized Pi RPC stdout record",
			fatal: true,
		});
		this.failProcess("Malformed Pi RPC protocol");
	}
	private record(record: Record<string, unknown>): void {
		if (this.eventsClosed) return;
		if (!record || typeof record.type !== "string") {
			this.protocolFailure();
			return;
		}
		if (record.type === "response") {
			if (
				typeof record.id !== "string" ||
				typeof record.command !== "string" ||
				typeof record.success !== "boolean"
			) {
				this.protocolFailure();
				return;
			}
			const item = this.pending.get(record.id);
			if (!item) return;
			if (record.command !== item.command) {
				this.protocolFailure();
				return;
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
			if (method === "setTitle") return;
			if (method === "setWidget") {
				const lines = Array.isArray(record.widgetLines)
					? record.widgetLines.filter(
							(line): line is string => typeof line === "string",
						)
					: [];
				if (lines.length)
					this.emit({
						sessionId: this.sessionId,
						kind: "activity",
						activityEvent: {
							type: "notification",
							text: redactDiagnosticText(lines.join("\n")),
							level: "status",
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
			)
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "thinking",
						active: update.type === "thinking_start",
					},
				});
			return;
		}
		if (record.type === "tool_execution_start") {
			if (
				typeof record.toolCallId === "string" &&
				typeof record.toolName === "string"
			)
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "tool_start",
						toolCallId: record.toolCallId,
						summary: toolActivitySummary(record.toolName, record.args),
					},
				});
			return;
		}
		if (record.type === "tool_execution_end") {
			if (typeof record.toolCallId === "string")
				this.emit({
					sessionId: this.sessionId,
					kind: "activity",
					activityEvent: {
						type: "tool_end",
						toolCallId: record.toolCallId,
						failed: record.isError === true,
					},
				});
			return;
		}
		if (["auto_compaction_start", "compaction_start"].includes(record.type))
			this.compacting = true;
		if (["auto_compaction_end", "compaction_end"].includes(record.type))
			this.compacting = false;
		if (["agent_start", "agent_end", "agent_settled"].includes(record.type)) {
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: record.type,
			});
			if (record.type === "agent_start") this.agentRunning = true;
			if (record.type === "agent_settled") {
				this.agentRunning = false;
				// Pi settles the whole queued run, without identifying individual inputs.
				for (const input of this.activeInputs.values()) {
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
			this.delivery(active.id, "failed", "Pi rejected the prompt");
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
			this.delivery(active.id, "failed", "Input canceled");
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
		const sendAsSteer = this.agentRunning || this.activeInputs.size > 0;
		const active: ActiveInput = {
			id: input.id,
			sentAsSteer: sendAsSteer,
			accepted: false,
			settled: false,
			uncertain: false,
			uncertainReported: false,
			canceling: false,
		};
		this.activeInputs.set(input.id, active);
		this.delivery(input.id, "pending");
		let response: Record<string, unknown>;
		try {
			response = await this.command(
				"prompt",
				{
					message: input.text,
					...(sendAsSteer ? { streamingBehavior: "steer" } : {}),
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
		if (response.success !== true) throw new Error("Pi rejected the prompt");
	}
	private completeActive(inputId: InputId): void {
		const active = this.activeInputs.get(inputId);
		if (!active) return;
		this.activeInputs.delete(inputId);
		this.delivery(active.id, "completed");
	}
	async cancel(inputId: InputId): Promise<void> {
		if (this.reloadPending) throw new PiControlError("RELOAD_BUSY");
		const active = this.activeInputs.get(inputId);
		if (!active) throw new Error("Input is not active");
		if (this.activeInputs.size > 1)
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
				this.delivery(inputId, "failed", "Input canceled");
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
	private failProcess(detail: string): void {
		if (!this.eventsClosed) this.closeEvents(detail);
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
	private closeEvents(detail: string): void {
		if (this.eventsClosed) return;
		this.eventsClosed = true;
		this.reloadPending = false;
		this.reloadDispatched = false;
		this.reloadTimedOut = false;
		this.releaseAbortGate();
		if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
		this.exitDrainTimer = undefined;
		for (const active of this.activeInputs.values()) {
			if (!active.uncertainReported)
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
			});
		}
		for (const waiter of this.waiters.splice(0))
			waiter({ value: undefined, done: true });
	}
}
