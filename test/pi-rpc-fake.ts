import { PassThrough } from "node:stream";
import { afterEach } from "vitest";
import type {
	ManagedProcess,
	ProcessLaunchRequest,
	ProcessProvider,
} from "../src/core/ports.js";
import type {
	AdapterId,
	Input,
	InputId,
	ProcessId,
	SessionId,
} from "../src/core/types.js";
import type { PiRpcHarnessAdapter } from "../src/harness/index.js";

/** Deterministic Pi 1.x-shaped RPC child process for harness tests. */
export interface FakeOptions {
	readonly holdPrompt?: boolean;
	readonly holdGetState?: boolean;
	/** Answer only the readiness get_state; later ones stay unanswered. */
	readonly holdLaterGetState?: boolean;
	readonly exitOnGetState?: boolean;
	readonly holdAbort?: boolean;
	readonly malformedPromptAck?: boolean;
	readonly exitOnPrompt?: boolean;
	readonly exitBeforePromptResponse?: boolean;
	readonly exitBeforeAbortResponse?: boolean;
	readonly sessionId?: string;
	readonly promptSuccess?: boolean;
	readonly promptDisposition?: string;
	readonly costReportMessage?: unknown;
	readonly reloadExtensionError?: {
		readonly extensionPath: string;
		readonly event: string;
	};
	readonly abortSuccess?: boolean;
	readonly exitOnTerm?: boolean;
	readonly missingStream?: "stdin" | "stdout" | "stderr";
	readonly commandListing?: (name: string) => unknown;
	readonly rpcResponses?: Readonly<
		Record<
			string,
			{
				readonly success?: boolean;
				readonly data?: unknown;
				readonly error?: unknown;
			}
		>
	>;
	readonly beforeResponse?: (
		command: Record<string, unknown>,
		stdout: PassThrough,
	) => void;
}
const children: ManagedProcess[] = [];
afterEach(async () => {
	await Promise.all(
		children.splice(0).map(async (child) => {
			child.stdin?.end();
			const exited = child.exit.then(
				() => true,
				() => true,
			);
			try {
				await Promise.race([
					exited,
					new Promise((resolve) => setTimeout(resolve, 50)),
				]);
				if (
					await Promise.race([
						exited,
						new Promise<boolean>((resolve) =>
							setTimeout(() => resolve(false), 1),
						),
					])
				)
					return;
			} catch {
				return;
			}
			try {
				await child.sendSignal("SIGKILL");
			} catch {
				/* already exited */
			}
		}),
	);
});

export function fakeProvider(options: FakeOptions = {}) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let finish!: (value: { code: number | null; signal: string | null }) => void;
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			finish = resolve;
		},
	);
	const commands: Record<string, unknown>[] = [];
	const signals: string[] = [];
	let launchRequest: ProcessLaunchRequest | undefined;
	let text = "";
	stdin.setEncoding("utf8");
	const complete = (
		code: number | null,
		signal: string | null,
		closeStreams = true,
	) => {
		if (!exited) {
			exited = true;
			finish({ code, signal });
			if (closeStreams) {
				stdout.end();
				stderr.end();
			}
		}
	};
	stdin.on("data", (chunk: string) => {
		text += chunk;
		for (;;) {
			const index = text.indexOf("\n");
			if (index < 0) break;
			const command = JSON.parse(text.slice(0, index)) as Record<
				string,
				unknown
			>;
			text = text.slice(index + 1);
			commands.push(command);
			if (command.type === "extension_ui_response") continue;
			if (command.type === "get_state" && options.holdGetState) continue;
			if (
				command.type === "get_state" &&
				options.holdLaterGetState &&
				commands.filter((item) => item.type === "get_state").length > 1
			)
				continue;
			if (command.type === "get_state" && options.exitOnGetState) {
				complete(1, null);
				continue;
			}
			if (command.type === "prompt" && options.exitOnPrompt) {
				complete(1, null);
				continue;
			}
			if (options.beforeResponse) {
				options.beforeResponse(command, stdout);
			}
			if (
				command.type === "prompt" &&
				command.message ===
					`/${String(launchRequest?.env?.HARNESSD_PI_RELOAD_COMMAND)}` &&
				options.reloadExtensionError
			) {
				stdout.write(
					`${JSON.stringify({
						type: "extension_error",
						...options.reloadExtensionError,
						extensionPath:
							options.reloadExtensionError.extensionPath === "$reload"
								? `command:${String(launchRequest?.env?.HARNESSD_PI_RELOAD_COMMAND)}`
								: options.reloadExtensionError.extensionPath,
						error: "reload failed",
					})}\n`,
				);
			}
			if (command.type === "prompt" && options.malformedPromptAck) {
				stdout.write(
					`${JSON.stringify({
						type: "response",
						id: command.id,
						command: "prompt",
						success: "yes",
					})}\n`,
				);
			}
			if (command.type === "abort" && options.holdAbort) continue;
			if (command.type === "prompt" && options.exitBeforePromptResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`${JSON.stringify({
							type: "response",
							id: command.id,
							command: "prompt",
							success: true,
							data: { disposition: "started" },
						})}\r\n{"type":"agent_settled"}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "abort" && options.exitBeforeAbortResponse) {
				complete(0, null, false);
				setImmediate(() => {
					stdout.write(
						`{"type":"agent_settled"}\r\n${JSON.stringify({
							type: "response",
							id: command.id,
							command: "abort",
							success: options.abortSuccess ?? true,
						})}\r\n`,
					);
					stdout.end();
					stderr.end();
				});
				continue;
			}
			if (command.type === "prompt" && options.holdPrompt) continue;
			const response =
				command.type === "get_state"
					? {
							type: "response",
							id: command.id,
							command: command.type,
							success: true,
							data: { sessionId: options.sessionId ?? "native-exact" },
						}
					: command.type === "get_commands"
						? {
								type: "response",
								id: command.id,
								command: command.type,
								success: true,
								data: {
									commands: options.commandListing?.(
										String(launchRequest?.env?.HARNESSD_PI_RELOAD_COMMAND),
									) ?? [
										{
											name: String(
												launchRequest?.env?.HARNESSD_PI_RELOAD_COMMAND,
											),
											source: "extension",
											description: "harnessd internal reload command",
										},
									],
								},
							}
						: {
								type: "response",
								id: command.id,
								command: command.type,
								success:
									command.type === "prompt"
										? (options.promptSuccess ?? true)
										: command.type === "abort"
											? (options.abortSuccess ?? true)
											: true,
								...(command.type === "prompt" && options.promptDisposition
									? {
											data: {
												disposition: options.promptDisposition,
											},
										}
									: {}),
							};
			if (command.type === "prompt" && options.costReportMessage !== undefined)
				stdout.write(
					`${JSON.stringify({
						type: "message_start",
						message: options.costReportMessage,
					})}\r\n`,
				);
			const override = options.rpcResponses?.[String(command.type)];
			stdout.write(
				`${JSON.stringify(override ? { ...response, ...override } : response)}\r\n`,
			);
		}
	});
	stdin.on("end", () => {
		if (options.exitOnTerm !== false) complete(0, null);
	});
	const managed: ManagedProcess = {
		id: `fake-${children.length}` as ProcessId,
		stdin: options.missingStream === "stdin" ? null : stdin,
		stdout: options.missingStream === "stdout" ? null : stdout,
		stderr: options.missingStream === "stderr" ? null : stderr,
		exit,
		async sendSignal(signal) {
			signals.push(signal);
			complete(null, signal);
		},
	};
	children.push(managed);
	const provider: ProcessProvider = {
		descriptor: {
			id: "fake" as AdapterId,
			capabilities: ["process.launch", "process.signal"],
		},
		async launch(request) {
			launchRequest = request;
			return managed;
		},
	};
	return {
		provider,
		commands,
		signals,
		stdout,
		stderr,
		child: managed,
		get launchRequest() {
			return launchRequest;
		},
	};
}
export const input = (text: string, id: string): Input => ({
	id: id as InputId,
	sessionId: "supervisor" as SessionId,
	text,
	createdAt: new Date(),
});
export async function collectEvents(
	instance: Awaited<ReturnType<PiRpcHarnessAdapter["launch"]>>,
	count: number,
) {
	const iterator = instance.events[Symbol.asyncIterator]();
	const result = [];
	for (let i = 0; i < count; i++) result.push((await iterator.next()).value);
	return result;
}
export const request = { sessionId: "supervisor" as SessionId, cwd: "/a cwd" };
