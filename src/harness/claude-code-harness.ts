import type {
	HarnessAdapter,
	HarnessInstance,
	HarnessLaunchRequest,
	ProcessProvider,
} from "../core/ports.js";
import type { AdapterId } from "../core/types.js";
import { createClaudeInstance } from "./claude-code-instance.js";

export interface ClaudeCodeHarnessOptions {
	readonly executable: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly acknowledgementTimeoutMs?: number;
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
	readonly descriptor = {
		id: "claude-code" as AdapterId,
		aliases: ["claude"],
		capabilities: [
			"harness.launch",
			"harness.stop",
			"harness.resume",
			"input.submit",
		] as const,
	};
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
			"manual",
		];
		if (resume) args.push("--resume", nativeId);
		else args.push("--session-id", nativeId);
		const child = await this.provider.launch({
			executable: this.options.executable,
			args,
			cwd: request.cwd,
			env: this.options.env ?? {},
			stdio: "pipe",
		});
		return createClaudeInstance(child, request, nativeId, timeout);
	}
}
