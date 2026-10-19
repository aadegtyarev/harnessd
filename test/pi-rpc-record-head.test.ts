import { describe, expect, it } from "vitest";
import { scanRecordHead } from "../src/harness/pi-rpc-record-head.js";

const fields = (head: string) => Object.fromEntries(scanRecordHead(head));

describe("scanRecordHead", () => {
	it("reads top-level scalars before a cut inside a large array", () => {
		const line = JSON.stringify({
			type: "agent_end",
			messages: [{ role: "user", content: "x".repeat(5000) }],
		});
		expect(fields(line.slice(0, 200))).toEqual({ type: "agent_end" });
	});

	it("reads tool identifiers and stops at a value cut by the head end", () => {
		const line = JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "y".repeat(5000) }] },
			isError: false,
		});
		expect(fields(line.slice(0, 400))).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
		});
		expect(fields(line)).toMatchObject({ isError: false });
	});

	it("reads the role of the top-level message object only", () => {
		const head = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ role: "nested", text: "z".repeat(100) }],
			},
		}).slice(0, 120);
		expect(fields(head)).toEqual({
			type: "message_end",
			"message.role": "assistant",
		});
	});

	it("reads ids in any order, decodes escapes, and skips a cut string", () => {
		expect(fields('{"id":"a\\"b","type":"response","command":"get_st')).toEqual(
			{ id: 'a"b', type: "response" },
		);
	});

	it("does not take a literal cut by the head end", () => {
		expect(fields('{"type":"x","isError":tr')).toEqual({ type: "x" });
		expect(fields('{"type":"x","count":12')).toEqual({ type: "x" });
		expect(fields('{"type":"x","isError":true,')).toEqual({
			type: "x",
			isError: true,
		});
	});

	it("returns nothing for non-object or malformed input and never throws", () => {
		expect(fields("not json")).toEqual({});
		expect(fields('["type"]')).toEqual({});
		expect(fields('{"type" "x"}')).toEqual({});
		expect(fields("[".repeat(20_000))).toEqual({});
		expect(fields(`{"a":${"[".repeat(20_000)}`)).toEqual({});
		expect(fields("")).toEqual({});
	});
});
