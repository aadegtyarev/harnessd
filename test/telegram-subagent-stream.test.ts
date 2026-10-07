import { describe, expect, it } from "vitest";
import { SubagentTextStream } from "../src/telegram-subagent-stream.js";

describe("SubagentTextStream framing", () => {
	it("preserves Markdown fences and blank lines while recognizing complete snapshots", () => {
		const stream = new SubagentTextStream();
		const marker =
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"scout","state":"running"}]}';
		const beforeFence = stream.consume("Hello\n\n```text\n");
		expect(beforeFence.visibleText).toBe("Hello\n\n```text\n");
		const fenced = stream.consume(marker);
		expect(fenced.visibleText).toBe("");
		expect(fenced.statuses).toEqual([]);
		const closed = stream.consume("\n```\n");
		expect(closed.visibleText).toBe([marker, "```", ""].join("\n"));
		const result = stream.consume(marker);
		expect(result.statuses).toEqual(["Задача Scout: выполняется"]);
		expect(result.visibleText).toBe("");
	});

	it("handles every two-chunk boundary across fences and exact widget framing", () => {
		const widget =
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[{"kind":"subagent","label":"scout","state":"running"}]}';
		const fencedMarker =
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[]}';
		const sample = [
			"Prose marker",
			"```typescript",
			fencedMarker,
			"```",
			`Pi: ${widget}`,
			"",
		].join("\n");
		const expectedVisible = [
			"Prose marker",
			"```typescript",
			fencedMarker,
			"```",
			"",
		].join("\n");
		for (let boundary = 0; boundary <= sample.length; boundary++) {
			const stream = new SubagentTextStream();
			const first = stream.consume(sample.slice(0, boundary));
			const second = stream.consume(sample.slice(boundary));
			const final = stream.consume("", true);
			expect(first.visibleText + second.visibleText + final.visibleText).toBe(
				expectedVisible,
			);
			expect([
				...first.statuses,
				...second.statuses,
				...final.statuses,
			]).toEqual(["Задача Scout: выполняется"]);
		}
		const stream = new SubagentTextStream();
		const prose = stream.consume("prose ");
		const continued = stream.consume(`${widget}\n`, true);
		expect(prose.visibleText + continued.visibleText).toBe(`prose ${widget}\n`);
		expect(continued.statuses).toEqual([]);
		const midLineFence = new SubagentTextStream();
		const proseFence = midLineFence.consume("prefix ```text\n");
		const after = midLineFence.consume(`${widget}\n`, true);
		expect(proseFence.visibleText + after.visibleText).toBe("prefix ```text\n");
		expect(after.statuses).toEqual(["Задача Scout: выполняется"]);
	});
});
