import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { requireCapability } from "../core/errors.js";
import type {
	HarnessAdapter as HarnessAdapterPort,
	HarnessInstance,
	HarnessLaunchRequest,
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

export interface PiRpcHarnessOptions {
	readonly executable: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly startupTimeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly exitDrainTimeoutMs?: number;
	readonly maxRecordBytes?: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

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
	readonly descriptor = {
		id: "pi-rpc" as AdapterId,
		capabilities: [
			"harness.launch",
			"harness.stop",
			"harness.resume",
			"harness.cancel",
			"input.submit",
		] as const,
	};
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
		const child = await this.processes.launch({
			executable: this.options.executable,
			args,
			cwd: request.cwd,
			env: this.options.env,
			stdio: "pipe",
		});
		if (!child.stdin || !child.stdout || !child.stderr) {
			await terminateChild(child, this.options.shutdownTimeoutMs ?? 1000);
			throw new Error("Pi RPC requires stdin, stdout, and stderr pipes");
		}
		const instance = new PiRpcInstance(child, request.sessionId, this.options);
		try {
			await instance.ready(resume ? request.nativeSessionId : undefined);
			return instance;
		} catch (error) {
			await instance.shutdown().catch(() => {});
			throw error;
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
}
interface ActiveInput {
	id: InputId;
	accepted: boolean;
	settled: boolean;
	uncertain: boolean;
	uncertainReported: boolean;
	canceling: boolean;
}
class PiRpcInstance implements HarnessInstance {
	readonly processId: ManagedProcess["id"];
	private readonly queue: HarnessEvent[] = [];
	private readonly waiters: ((result: IteratorResult<HarnessEvent>) => void)[] =
		[];
	private readonly pending = new Map<string, PendingCommand>();
	private nativeId?: string;
	private active?: ActiveInput;
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
	) {
		this.processId = child.id;
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
			if (this.eventsClosed) return;
			this.exitDetail = `Pi process exited (${exit.code ?? exit.signal ?? "unknown"})`;
			if (this.stdoutEnded) queueMicrotask(() => this.finalizeChildExit(false));
			else this.scheduleExitDrain();
		});
	}
	get nativeSessionId(): string | undefined {
		return this.nativeId;
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
			if (item.command === "prompt")
				this.applyPromptResponse(record, item.inputId);
			else if (item.command === "abort")
				this.applyAbortResponse(record, item.inputId);
			item.resolve(record);
			return;
		}
		if (record.type === "extension_ui_request") {
			const dialogMethods = ["select", "confirm", "input", "editor"];
			if (!dialogMethods.includes(String(record.method))) {
				this.emit({
					sessionId: this.sessionId,
					kind: "error",
					text: "Unsupported Pi extension UI request",
				});
				return;
			}
			if (typeof record.id !== "string") {
				this.protocolFailure();
				return;
			}
			this.emit({
				sessionId: this.sessionId,
				kind: "error",
				text: "Unsupported Pi extension UI dialog cancelled",
			});
			void this.write({
				type: "extension_ui_response",
				id: record.id,
				cancelled: true,
			}).catch(() => {});
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
			return;
		}
		if (["agent_start", "agent_end", "agent_settled"].includes(record.type)) {
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: record.type,
			});
			if (record.type === "agent_settled" && this.active) {
				this.active.settled = true;
				if (this.active.uncertain) this.active = undefined;
				else if (this.active.accepted && !this.active.canceling)
					this.completeActive();
			}
		}
	}
	private applyPromptResponse(
		response: Record<string, unknown>,
		inputId?: InputId,
	): void {
		const active = this.active;
		if (!active || active.id !== inputId) return;
		if (response.success !== true) {
			this.active = undefined;
			this.delivery(active.id, "failed", "Pi rejected the prompt");
			return;
		}
		active.accepted = true;
		this.delivery(active.id, "accepted");
		const disposition = (response.data as Record<string, unknown> | undefined)
			?.disposition;
		if (disposition === "handled") active.settled = true;
		if (active.settled) this.completeActive();
	}
	private applyAbortResponse(
		response: Record<string, unknown>,
		inputId?: InputId,
	): void {
		const active = this.active;
		if (!active || active.id !== inputId || !active.canceling) return;
		if (response.success === true) {
			this.active = undefined;
			this.delivery(active.id, "failed", "Input canceled");
			return;
		}
		active.canceling = false;
		if (active.settled) this.completeActive();
	}
	private write(value: Record<string, unknown>): Promise<void> {
		const line = `${JSON.stringify(value)}\n`;
		this.writeChain = this.writeChain.then(async () => {
			const stdin = this.child.stdin as Writable;
			if (stdin.destroyed || stdin.writableEnded)
				throw new Error("Pi stdin is closed");
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
		return this.writeChain;
	}
	private async command(
		command: string,
		extra: Record<string, unknown> = {},
		inputId?: InputId,
	): Promise<Record<string, unknown>> {
		if (this.eventsClosed) throw new Error("Pi process is closed");
		const id = randomUUID();
		let resolveResponse!: (record: Record<string, unknown>) => void;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		const pending: PendingCommand = {
			command,
			...(inputId !== undefined ? { inputId } : {}),
			resolve: resolveResponse,
			reject: rejectResponse,
		};
		pending.timer = setTimeout(() => {
			this.pending.delete(id);
			rejectResponse(new Error(`Pi RPC ${command} timed out`));
		}, this.options.commandTimeoutMs ?? 30_000);
		this.pending.set(id, pending);
		void response.catch(() => {});
		try {
			await within(
				this.write({ id, type: command, ...extra }),
				this.options.commandTimeoutMs ?? 30_000,
				`Pi RPC ${command} write timed out`,
			);
		} catch (error) {
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
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
		this.nativeId = sessionId;
		return sessionId;
	}
	async send(input: Input): Promise<void> {
		if (this.eventsClosed) throw new Error("Pi harness is closed");
		if (this.active) throw new Error("An input is already active");
		this.active = {
			id: input.id,
			accepted: false,
			settled: false,
			uncertain: false,
			uncertainReported: false,
			canceling: false,
		};
		this.delivery(input.id, "pending");
		let response: Record<string, unknown>;
		try {
			response = await this.command(
				"prompt",
				{ message: input.text },
				input.id,
			);
		} catch (error) {
			if (this.active?.id === input.id) {
				this.active.uncertain = true;
				this.active.uncertainReported = true;
				this.delivery(
					input.id,
					"uncertain",
					"Pi prompt response was not received",
				);
				if (this.active.settled) this.active = undefined;
			}
			throw new UncertainInputDeliveryError(input.id, { cause: error });
		}
		if (response.success !== true) {
			if (this.active?.id === input.id) {
				this.active = undefined;
				this.delivery(input.id, "failed", "Pi rejected the prompt");
			}
			throw new Error("Pi rejected the prompt");
		}
	}
	private completeActive(): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		this.delivery(active.id, "completed");
	}
	async cancel(inputId: InputId): Promise<void> {
		if (this.active?.id !== inputId) throw new Error("Input is not active");
		if (!this.active.accepted || this.active.uncertain)
			throw new Error("Input cannot be canceled before acknowledged delivery");
		if (this.active.canceling)
			throw new Error("Input cancellation is already in progress");
		this.active.canceling = true;
		let response: Record<string, unknown>;
		try {
			response = await this.command("abort", {}, inputId);
		} catch (error) {
			if (this.active?.id === inputId) {
				this.active.uncertain = true;
				this.active.uncertainReported = true;
				this.delivery(
					inputId,
					"uncertain",
					"Pi abort response was not received",
				);
				if (this.active.settled) this.active = undefined;
			}
			throw error;
		}
		if (response.success !== true) {
			if (this.active?.id === inputId) {
				this.active.canceling = false;
				if (this.active.settled) this.completeActive();
			}
			throw new Error("Pi rejected the abort command");
		}
		if (this.active?.id === inputId) {
			this.active = undefined;
			this.delivery(inputId, "failed", "Input canceled");
		}
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
		if (this.exitDrainTimer) clearTimeout(this.exitDrainTimer);
		this.exitDrainTimer = undefined;
		if (this.active) {
			const active = this.active;
			this.active = undefined;
			if (!active.uncertainReported)
				this.delivery(active.id, "uncertain", detail);
		}
		for (const [id, item] of this.pending) {
			if (item.timer) clearTimeout(item.timer);
			item.reject(new Error(detail));
			this.pending.delete(id);
		}
		if (!this.failureReported && detail !== "Pi harness shut down") {
			this.failureReported = true;
			this.emit({ sessionId: this.sessionId, kind: "error", text: detail });
		}
		for (const waiter of this.waiters.splice(0))
			waiter({ value: undefined, done: true });
	}
}
