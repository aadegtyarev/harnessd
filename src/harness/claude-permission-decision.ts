import type { Writable } from "node:stream";
import type {
	ToolPermissionDecision,
	ToolPermissionHandler,
} from "../core/ports.js";
import type { InputId, SessionId } from "../core/types.js";
import { createPermissionRequest } from "./claude-permission-record.js";
import { writePermissionDecision } from "./claude-permission-response.js";
import { waitForPermissionDecision } from "./claude-permission-timeout.js";

export class ClaudePermissionDecision {
	private pending?: {
		readonly id: string;
		readonly abort: AbortController;
		timer?: ReturnType<typeof setTimeout>;
	};
	constructor(
		private readonly sessionId: SessionId,
		private readonly activeInput: () => InputId | undefined,
		private readonly handler: ToolPermissionHandler | undefined,
		private readonly stdin: Writable,
		private readonly fail: () => void,
	) {}

	cancel(id: string): void {
		if (this.pending?.id !== id) return;
		if (this.pending.timer) clearTimeout(this.pending.timer);
		this.pending.abort.abort();
		this.pending = undefined;
	}

	close(): void {
		if (this.pending?.timer) clearTimeout(this.pending.timer);
		this.pending?.abort.abort();
		this.pending = undefined;
	}

	async handle(id: string, request: Record<string, unknown>): Promise<void> {
		const inputId = this.activeInput();
		if (!inputId || this.pending) {
			await this.send(id, {
				behavior: "deny",
				message: "Permission request is not available",
				interrupt: false,
			});
			return;
		}
		const abort = new AbortController();
		const permission = createPermissionRequest(
			this.sessionId,
			inputId,
			id,
			request,
			abort.signal,
		);
		if (!permission) {
			await this.send(id, {
				behavior: "deny",
				message: "Permission request is invalid or too large",
				interrupt: false,
			});
			return;
		}
		this.pending = { id, abort };
		try {
			const prompt = this.handler
				? this.handler(permission)
				: Promise.resolve<ToolPermissionDecision>({
						behavior: "deny",
						message: "Permission prompt unavailable",
						interrupt: false,
					});
			const decision = await waitForPermissionDecision(prompt, (timer) => {
				if (this.pending?.id === id) this.pending.timer = timer;
			});
			if (this.pending?.id !== id || abort.signal.aborted) return;
			await this.send(id, decision);
		} catch {
			if (this.pending?.id === id && !abort.signal.aborted)
				await this.send(id, {
					behavior: "deny",
					message: "Permission was not granted",
					interrupt: false,
				});
		} finally {
			abort.abort();
			if (this.pending?.id === id) this.pending = undefined;
		}
	}

	private send(id: string, decision: ToolPermissionDecision): Promise<void> {
		return writePermissionDecision(this.stdin, id, decision).catch(() =>
			this.fail(),
		);
	}
}
