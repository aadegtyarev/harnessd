import { describe, expect, it } from "vitest";
import {
	ClaudeJsonlFramer,
	parseClaudeRecord,
} from "../src/harness/claude-jsonl.js";

describe("Claude JSONL framing", () => {
	it("frames CRLF across chunks", () => {
		const lines: string[] = [];
		const framer = new ClaudeJsonlFramer((line) => lines.push(line));
		framer.push(Buffer.from('{"type":"result"}\r'));
		framer.push(Buffer.from("\n"));
		framer.finish();
		expect(lines).toEqual(['{"type":"result"}']);
	});
	it("rejects malformed, oversized, and truncated records", () => {
		expect(() => parseClaudeRecord("{")).toThrow("CLAUDE_INVALID_JSON");
		const framer = new ClaudeJsonlFramer(() => {});
		expect(() => framer.push(Buffer.alloc(1024 * 1024 + 1))).toThrow(
			"CLAUDE_RECORD_TOO_LARGE",
		);
		const truncated = new ClaudeJsonlFramer(() => {});
		truncated.push(Buffer.from("{"));
		expect(() => truncated.finish()).toThrow("CLAUDE_TRUNCATED_RECORD");
	});
});
