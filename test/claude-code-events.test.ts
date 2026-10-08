import { describe, expect, it } from "vitest";
import type { InputId, SessionId } from "../src/core/types.js";
import { mapClaudeEvent } from "../src/harness/claude-code-events.js";

const ids = { sessionId: "s" as SessionId, inputId: "i" as InputId };

describe("Claude event projection", () => {
	it("projects text and replay acknowledgement without payload metadata", () => {
		expect(
			mapClaudeEvent(
				{ type: "user", isReplay: true, session_id: "secret" },
				ids.sessionId,
				ids.inputId,
			)[0],
		).toMatchObject({ kind: "input", inputEvent: { state: "accepted" } });
		expect(
			mapClaudeEvent(
				{
					type: "stream_event",
					event: {
						delta: { type: "text_delta", text: "hello" },
						model: "private",
					},
				},
				ids.sessionId,
				ids.inputId,
			)[0],
		).toEqual({ sessionId: ids.sessionId, kind: "output", text: "hello" });
	});
	it("projects protocol errors as fixed safe events", () => {
		expect(
			mapClaudeEvent(
				{ type: "error", message: "credential-bearing detail" },
				ids.sessionId,
			),
		).toEqual([
			{
				sessionId: ids.sessionId,
				kind: "error",
				text: "Claude reported an error",
			},
		]);
		expect(
			mapClaudeEvent(
				{ type: "result", subtype: "error", is_error: true, error: "private" },
				ids.sessionId,
				ids.inputId,
			),
		).toMatchObject([
			{ kind: "error", text: "Claude request failed" },
			{ kind: "input", inputEvent: { state: "failed" } },
		]);
	});
	it("does not fabricate usage when absent", () => {
		const events = mapClaudeEvent(
			{ type: "result", subtype: "success", result: "done" },
			ids.sessionId,
			ids.inputId,
		);
		expect(events).toMatchObject([
			{ kind: "input", inputEvent: { state: "completed" } },
		]);
		expect(JSON.stringify(events)).not.toContain("usage");
	});
});
