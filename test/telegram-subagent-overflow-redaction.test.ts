import { describe, expect, it } from "vitest";
import { SubagentTextStream } from "../src/telegram-subagent-stream.js";

describe("oversized subagent envelope redaction", () => {
	it("redacts oversized envelopes after arbitrary leading whitespace at every prefix boundary", () => {
		const body = JSON.stringify({
			kind: "pi-subagents.async-status-snapshot",
			runs: [{ kind: "subagent", label: "scout", state: "running" }],
			ignored: "x".repeat(33_000),
			id: "WHITESPACE_SENTINEL",
		});
		const raw = `${" ".repeat(129)}Pi: PI_SUBAGENT_ASYNC_JSON:${body}\n`;
		const prefixes = `${" ".repeat(129)}Pi: PI_SUBAGENT_ASYNC_JSON:`;
		for (let boundary = 0; boundary <= prefixes.length; boundary++) {
			const stream = new SubagentTextStream();
			const first = stream.consume(raw.slice(0, boundary));
			const second = stream.consume(raw.slice(boundary));
			const final = stream.consume("", true);
			expect(first.visibleText + second.visibleText + final.visibleText).toBe(
				"",
			);
			expect([
				...first.statuses,
				...second.statuses,
				...final.statuses,
			]).toEqual([]);
		}
		const singleChunk = new SubagentTextStream().consume(raw);
		expect(singleChunk.visibleText).toBe("");
		expect(singleChunk.statuses).toEqual([]);

		const padded = new SubagentTextStream();
		padded.consume(" ".repeat(33_000));
		for (const char of "Pi: PI_SUBAGENT_ASYNC_JSON:") padded.consume(char);
		const suffix = padded.consume(`${body}\nVisible\n`, true);
		expect(suffix.visibleText).toBe("Visible\n");
		expect(suffix.visibleText).not.toContain("WHITESPACE_SENTINEL");
	});
});
