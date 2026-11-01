import { describe, expect, it } from "vitest";
import { parseEvent } from "../src/llm-sessiond/ws-event.js";

const base = {
	apiVersion: "v1",
	eventId: 1,
	sessionId: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
	at: "2026-11-01T00:00:00.000Z",
};
const activities: unknown[] = [
	{ type: "agent_start" },
	{ type: "agent_end" },
	{ type: "agent_settled" },
	{ type: "compaction_start" },
	{ type: "compaction_end" },
	{ type: "assistant_message_end" },
	{ type: "thinking", active: true },
	{ type: "tool_start", toolCallId: "t1" },
	{ type: "tool_start", toolCallId: "t1", toolName: "read" },
	{ type: "tool_end", toolCallId: "t1" },
	{ type: "tool_end", toolCallId: "t1", toolName: "read", failed: true },
];
const normative = [
	...(["starting", "running", "stopped", "failed", "uncertain"] as const).map(
		(status) => ["session.status", { status }] as const,
	),
	...(
		[
			"PI_STARTUP_FAILED",
			"PI_RESUME_FAILED",
			"PI_PROCESS_EXITED",
			"PI_MALFORMED_JSON",
		] as const
	).map(
		(code) =>
			[
				"session.status",
				{ status: "failed", failure: { code, at: base.at } },
			] as const,
	),
	...["pending", "accepted", "completed", "failed", "uncertain"].map(
		(state) =>
			[
				"input.state",
				{
					inputId: "d86ce5ad-e311-4a9b-8e4e-1734e5b6b10e",
					state,
					reason: "reason",
				},
			] as const,
	),
	["assistant.delta", { text: "delta" }],
	...activities.map((activity) => ["activity", activity]),
	["notification", { text: "notice" }],
	["session.error", { code: "INTERNAL_ERROR" }],
	["turn.completed", {}],
] as const;

describe("API v1 strict event schema", () => {
	it("accepts every normative event and activity envelope shape", () => {
		for (const [type, data] of normative)
			expect(parseEvent(JSON.stringify({ ...base, type, data }))).toMatchObject(
				{ type, data },
			);
	});
	it("rejects unknown event types, envelope fields, and activity fields", () => {
		for (const value of [
			{ ...base, type: "unknown", data: {} },
			{ ...base, type: "turn.completed", data: {}, surprise: true },
			{
				...base,
				type: "activity",
				data: { type: "agent_start", surprise: true },
			},
		])
			expect(() => parseEvent(JSON.stringify(value))).toThrow();
	});
});
