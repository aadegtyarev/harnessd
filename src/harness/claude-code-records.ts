import type { HarnessEvent, SessionId } from "../core/types.js";
import type { ClaudeEventQueue } from "./claude-event-queue.js";

export interface ClaudeRecordHooks {
	onUser(content: string): void;
	onOutput(text: string): void;
	onResult(failed: boolean): void;
}

export class ClaudeCodeRecords {
	private ready = false;
	constructor(
		private readonly sessionId: SessionId,
		private readonly nativeId: string,
		private readonly events: ClaudeEventQueue,
		private readonly hooks: ClaudeRecordHooks,
	) {}
	accept(record: Record<string, unknown>): void {
		if (typeof record.type !== "string") throw new Error();
		if (
			record.session_id !== undefined &&
			(typeof record.session_id !== "string" ||
				record.session_id !== this.nativeId)
		)
			throw new Error();
		if (record.type === "system" && typeof record.subtype !== "string")
			throw new Error();
		if (record.type === "system" && record.subtype === "init") {
			if (this.ready || record.session_id !== this.nativeId) throw new Error();
			this.ready = true;
			this.emit({
				sessionId: this.sessionId,
				kind: "status",
				text: "Claude session ready",
			});
			return;
		}
		if (!this.ready) {
			if (record.type === "system") return;
			throw new Error();
		}
		if (record.type === "user") this.user(record);
		else if (record.type === "stream_event") this.stream(record);
		else if (record.type === "result") this.result(record);
		else if (record.type === "error") {
			if (typeof record.subtype !== "string") throw new Error();
			this.emit({
				sessionId: this.sessionId,
				kind: "error",
				text: "Claude reported an error",
			});
		}
	}
	private user(record: Record<string, unknown>): void {
		if (
			record.isReplay !== true ||
			!record.message ||
			typeof record.message !== "object"
		)
			throw new Error();
		const message = record.message as Record<string, unknown>;
		if (message.role !== "user" || typeof message.content !== "string")
			throw new Error();
		this.hooks.onUser(message.content);
	}
	private stream(record: Record<string, unknown>): void {
		if (!record.event || typeof record.event !== "object") throw new Error();
		const event = record.event as Record<string, unknown>;
		if (typeof event.type !== "string") throw new Error();
		if (event.type !== "content_block_delta") return;
		if (!event.delta || typeof event.delta !== "object") throw new Error();
		const delta = event.delta as Record<string, unknown>;
		if (typeof delta.type !== "string") throw new Error();
		if (delta.type === "text_delta") {
			if (typeof delta.text !== "string") throw new Error();
			this.hooks.onOutput(delta.text);
		}
	}
	private result(record: Record<string, unknown>): void {
		if (
			record.session_id !== this.nativeId ||
			typeof record.subtype !== "string" ||
			typeof record.is_error !== "boolean" ||
			(!record.is_error &&
				record.subtype === "success" &&
				typeof record.result !== "string")
		)
			throw new Error();
		this.hooks.onResult(record.is_error || record.subtype !== "success");
	}
	private emit(event: HarnessEvent): void {
		if (!this.events.push(event))
			throw new Error("CLAUDE_EVENT_QUEUE_OVERFLOW");
	}
}
