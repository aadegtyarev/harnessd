import type { Writable } from "node:stream";
import type { ToolPermissionHandler } from "../core/ports.js";
import type { InputId, SessionId } from "../core/types.js";
import { ClaudePermissionDecision } from "./claude-permission-decision.js";
import { ClaudePermissionRouter } from "./claude-permission-router.js";

export class ClaudePermissionController {
	private readonly decision: ClaudePermissionDecision;
	private readonly router: ClaudePermissionRouter;
	constructor(
		sessionId: SessionId,
		activeInput: () => InputId | undefined,
		handler: ToolPermissionHandler | undefined,
		stdin: Writable,
		fail: () => void,
	) {
		this.decision = new ClaudePermissionDecision(
			sessionId,
			activeInput,
			handler,
			stdin,
			fail,
		);
		this.router = new ClaudePermissionRouter(
			stdin,
			fail,
			(id, request) => void this.decision.handle(id, request),
			(id) => this.decision.cancel(id),
		);
	}

	accept(record: Record<string, unknown>): boolean {
		return this.router.accept(record);
	}

	settle(): void {
		this.decision.settle();
	}

	close(): void {
		this.decision.close();
	}
}
