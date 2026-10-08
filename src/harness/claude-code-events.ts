import type { HarnessEvent, InputId, SessionId } from "../core/types.js";

export function mapClaudeEvent(
	record: Record<string, unknown>,
	sessionId: SessionId,
	inputId?: InputId,
): HarnessEvent[] {
	const type = record.type;
	if (type === "system" && record.subtype === "init") {
		if (typeof record.session_id !== "string")
			throw new Error("CLAUDE_MISSING_SESSION_ID");
		return [{ sessionId, kind: "status", text: "Claude session ready" }];
	}
	if (type === "user" && inputId)
		return [
			{ sessionId, kind: "input", inputEvent: { inputId, state: "accepted" } },
		];
	if (type === "stream_event") {
		const event = record.event as Record<string, unknown> | undefined;
		const delta = event?.delta as Record<string, unknown> | undefined;
		if (delta?.type === "text_delta" && typeof delta.text === "string")
			return [{ sessionId, kind: "output", text: delta.text }];
	}
	if (type === "error")
		return [{ sessionId, kind: "error", text: "Claude reported an error" }];
	if (type === "result") {
		const failed = record.is_error === true || record.subtype !== "success";
		const events: HarnessEvent[] = failed
			? [{ sessionId, kind: "error", text: "Claude request failed" }]
			: [];
		if (inputId)
			events.push({
				sessionId,
				kind: "input",
				inputEvent: { inputId, state: failed ? "failed" : "completed" },
			});
		return events;
	}
	return [];
}
