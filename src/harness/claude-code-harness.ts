import { fileURLToPath } from "node:url";
import type {
	AgentFileSendHandler,
	HarnessAdapter,
	HarnessInstance,
	HarnessLaunchRequest,
	ManagedProcess,
	ProcessProvider,
} from "../core/ports.js";
import type { AdapterId } from "../core/types.js";
import { startAgentFileSendBridge } from "./agent-file-send-bridge.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "./agent-file-send-protocol.js";
import { createClaudeInstance } from "./claude-code-instance.js";

const PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"plan",
	"bypassPermissions",
	"dontAsk",
	"auto",
] as const;
const CLAUDE_MODELS = ["sonnet", "opus", "haiku"] as const;
const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

export interface ClaudeCodeHarnessOptions {
	readonly executable: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly acknowledgementTimeoutMs?: number;
	readonly agentFileSend?: AgentFileSendHandler;
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
	get descriptor() {
		return {
			id: "claude-code" as AdapterId,
			aliases: ["claude"],
			capabilities: [
				"harness.launch",
				"harness.stop",
				"harness.resume",
				"input.submit",
				"harness.options.set",
				...(this.options.agentFileSend ? ["harness.file.send" as const] : []),
			] as const,
			options: [
				{
					key: "model",
					label: "Модель",
					values: CLAUDE_MODELS,
					allowCustom: true,
				},
				{ key: "effort", label: "Уровень усилий", values: EFFORT_LEVELS },
				{
					key: "permissionMode",
					label: "Разрешения",
					values: PERMISSION_MODES,
					dangerousValues: ["bypassPermissions"],
				},
			] as const,
		};
	}
	constructor(
		private readonly provider: ProcessProvider,
		private readonly options: ClaudeCodeHarnessOptions,
	) {}
	launch(request: HarnessLaunchRequest): Promise<HarnessInstance> {
		return this.start(request, false);
	}
	resume(request: HarnessLaunchRequest): Promise<HarnessInstance> {
		return this.start(request, true);
	}
	private async start(
		request: HarnessLaunchRequest,
		resume: boolean,
	): Promise<HarnessInstance> {
		const timeout = this.options.acknowledgementTimeoutMs ?? 15_000;
		if (
			!Number.isSafeInteger(timeout) ||
			timeout < 1 ||
			timeout > 2_147_483_647
		)
			throw new Error("CLAUDE_INVALID_TIMEOUT");
		const savedNativeId = request.nativeSessionId;
		if (resume && !savedNativeId) throw new Error("CLAUDE_NATIVE_ID_REQUIRED");
		const nativeId = savedNativeId ?? request.sessionId;
		const permissionMode = request.adapterOptions?.permissionMode ?? "default";
		if (
			!PERMISSION_MODES.includes(
				permissionMode as (typeof PERMISSION_MODES)[number],
			)
		)
			throw new Error("CLAUDE_INVALID_PERMISSION_MODE");
		const model = request.adapterOptions?.model;
		if (
			model !== undefined &&
			(typeof model !== "string" ||
				!model ||
				model.length > 128 ||
				/\s/.test(model))
		)
			throw new Error("CLAUDE_INVALID_MODEL");
		const effort = request.adapterOptions?.effort;
		if (
			effort !== undefined &&
			!EFFORT_LEVELS.includes(effort as (typeof EFFORT_LEVELS)[number])
		)
			throw new Error("CLAUDE_INVALID_EFFORT");
		let fileSendBridge:
			| Awaited<ReturnType<typeof startAgentFileSendBridge>>
			| undefined;
		const args = [
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--replay-user-messages",
			"--permission-mode",
			permissionMode as string,
			"--permission-prompt-tool",
			"stdio",
		];
		if (typeof model === "string") args.push("--model", model);
		if (typeof effort === "string") args.push("--effort", effort);
		if (resume) args.push("--resume", nativeId);
		else args.push("--session-id", nativeId);
		if (this.options.agentFileSend) {
			fileSendBridge = await startAgentFileSendBridge(
				request.sessionId,
				this.options.agentFileSend,
			);
			const serverPath = fileURLToPath(
				new URL("./claude-send-file-mcp-server.js", import.meta.url),
			);
			const config = {
				mcpServers: {
					harnessd: {
						type: "stdio",
						command: process.execPath,
						args: [serverPath],
						env: {
							[AGENT_FILE_SEND_URL_ENV]: fileSendBridge.url,
							[AGENT_FILE_SEND_TOKEN_ENV]: fileSendBridge.token,
						},
					},
				},
			};
			args.push(
				"--mcp-config",
				JSON.stringify(config),
				"--strict-mcp-config",
				"--allowedTools",
				"mcp__harnessd__send_file",
			);
		}
		let child: ManagedProcess;
		try {
			child = await this.provider.launch({
				executable: this.options.executable,
				args,
				cwd: request.cwd,
				env: this.options.env ?? {},
				stdio: "pipe",
			});
		} catch (error) {
			await fileSendBridge?.close();
			throw error;
		}
		if (fileSendBridge)
			void child.exit.then(
				() => fileSendBridge?.close(),
				() => fileSendBridge?.close(),
			);
		try {
			return createClaudeInstance(child, request, nativeId, timeout, () =>
				fileSendBridge?.close(),
			);
		} catch (error) {
			await fileSendBridge?.close();
			throw error;
		}
	}
}
