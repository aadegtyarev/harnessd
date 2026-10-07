import { describe, expect, it } from "vitest";
import { parseSubagentWidgetLine } from "../src/telegram-subagent-status.js";
import { SubagentTextStream } from "../src/telegram-subagent-stream.js";

describe("parseSubagentWidgetLine", () => {
	it("normalizes only the last relevant run and ignores all extra fields", () => {
		const line = ` Pi: PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
			kind: "pi-subagents.async-status-snapshot",
			generatedAt: "SENTINEL_TIME",
			runs: [
				{
					kind: "subagent",
					label: "scout",
					state: "queued",
					id: "SENTINEL_ID",
				},
				{ kind: "other", label: "worker", state: "running" },
				{
					kind: "subagent",
					label: "REVIEWER",
					state: "active",
					children: ["secret"],
				},
			],
		})}`;
		expect(parseSubagentWidgetLine(line)).toEqual({
			matched: true,
			status: "Задача Reviewer: выполняется",
		});
	});

	it("maps allowed states and unknown roles", () => {
		for (const [state, translated] of [
			["pending", "ожидает"],
			["completed", "завершён"],
			["failed", "ошибка"],
		] as const) {
			expect(
				parseSubagentWidgetLine(
					`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
						kind: "pi-subagents.async-status-snapshot",
						runs: [{ kind: "subagent", label: "untrusted", state }],
					})}`,
				).status,
			).toBe(`Задача Помощник: ${translated}`);
		}
	});

	it("treats prototype property names as unknown role and state", () => {
		for (const value of ["constructor", "__proto__"])
			expect(
				parseSubagentWidgetLine(
					`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
						kind: "pi-subagents.async-status-snapshot",
						runs: [{ kind: "subagent", label: value, state: value }],
					})}`,
				).status,
			).toBe("Задача помощника: обновляется");
	});

	it("hides malformed, unsupported, empty, and preserves lookalikes", () => {
		for (const line of [
			" PI_SUBAGENT_ASYNC_JSON:{broken}",
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"wrong","runs":[]}',
			'PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot","runs":[]}',
		])
			expect(parseSubagentWidgetLine(line).matched).toBe(true);
		for (const line of [
			"prose PI_SUBAGENT_ASYNC_JSON:{}",
			"`PI_SUBAGENT_ASYNC_JSON:{}`",
			"> PI_SUBAGENT_ASYNC_JSON:{}",
		])
			expect(parseSubagentWidgetLine(line).matched).toBe(false);
	});

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
