import { describe, expect, it } from "vitest";
import { SubagentTextStream } from "../src/telegram-subagent-stream.js";

describe("oversized prefix overflow handling", () => {
	it("resolves partitioned marker lookalikes as prose without swallowing later lines", () => {
		const spaces = " ".repeat(33_000);
		const split = new SubagentTextStream();
		const whitespace = split.consume(spaces);
		const candidate = split.consume("P");
		const prose = split.consume("rose\nVisible\n");
		expect(whitespace.visibleText + candidate.visibleText).toBe("");
		expect(whitespace.overflow || candidate.overflow).toBe(false);
		expect(prose.overflow).toBe(true);
		expect(prose.visibleText).toContain("Prose\n");
		expect(prose.visibleText).toContain("Visible\n");

		for (const prefix of ["P", "Pi", "Pi: ", "Pi: PI_SUBAGENT_"]) {
			const stream = new SubagentTextStream();
			const pending = stream.consume(`${spaces}${prefix}`);
			const divergent = stream.consume("rose\nVisible\n", true);
			expect(pending.visibleText).toBe("");
			expect(divergent.overflow).toBe(true);
			expect(divergent.visibleText).toContain("Visible\n");
		}
	});

	it("keeps whitespace-only and whitespace-prefixed prose on ordinary overflow", () => {
		const spaces = " ".repeat(33_000);
		const whitespace = new SubagentTextStream().consume(`${spaces}\n`);
		expect(whitespace.overflow).toBe(true);
		expect(whitespace.visibleText.length).toBe(32_769);
		const proseStream = new SubagentTextStream();
		const leading = proseStream.consume(spaces);
		const prose = proseStream.consume("ordinary prose\n");
		expect(leading.overflow).toBe(false);
		expect(prose.overflow).toBe(true);
		expect(prose.visibleText).toContain("ordinary prose\n");
	});

	it("discards oversized service envelopes but preserves oversized lookalikes", () => {
		const service = new SubagentTextStream().consume(
			`PI_SUBAGENT_ASYNC_JSON:${"x".repeat(33_000)}\nVisible\n`,
		);
		expect(service.visibleText).toBe("Visible\n");
		expect(service.statuses).toEqual([]);
		const marker = `PI_SUBAGENT_ASYNC_JSON:${"x".repeat(33_000)}`;
		const fenced = new SubagentTextStream().consume(
			["```", marker, "```", ""].join("\n"),
		);
		expect(fenced.visibleText).toContain(marker);
		expect(fenced.statuses).toEqual([]);
		const prose = new SubagentTextStream().consume(
			`ordinary ${marker}\n`,
			true,
		);
		expect(prose.visibleText).toContain(marker);
		expect(prose.statuses).toEqual([]);
	});
});
