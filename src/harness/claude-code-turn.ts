import type { InputId, SessionId } from "../core/types.js";
import type { ClaudeEventQueue } from "./claude-event-queue.js";

export class ClaudeCodeTurn {
	constructor(
		private readonly sessionId: SessionId,
		private readonly events: ClaudeEventQueue,
		private readonly overflow: () => void,
	) {}
	start(inputId: InputId): void {
		this.push({
			sessionId: this.sessionId,
			kind: "input",
			inputEvent: { inputId, state: "accepted" },
		});
		this.push({
			sessionId: this.sessionId,
			kind: "status",
			text: "agent_start",
		});
	}
	output(text: string): void {
		this.push({ sessionId: this.sessionId, kind: "output", text });
	}
	settle(inputId: InputId, failed: boolean): void {
		if (failed)
			this.push({
				sessionId: this.sessionId,
				kind: "error",
				text: "Claude request failed",
			});
		this.push({
			sessionId: this.sessionId,
			kind: "input",
			inputEvent: { inputId, state: failed ? "failed" : "completed" },
		});
		this.push({
			sessionId: this.sessionId,
			kind: "status",
			text: "agent_settled",
		});
	}
	private push(event: import("../core/types.js").HarnessEvent): void {
		if (!this.events.push(event)) {
			this.overflow();
			throw new Error("CLAUDE_EVENT_QUEUE_OVERFLOW");
		}
	}
}
