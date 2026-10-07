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
		expect(fenced.visibleText).toBe(marker);
		expect(fenced.statuses).toEqual([]);
		stream.consume("\n```\n");
		const result = stream.consume(marker);
		expect(result.statuses).toEqual(["Задача Scout: выполняется"]);
		expect(result.visibleText).toBe("");
	});

	it("discards oversized envelope lines without buffering them", () => {
		const stream = new SubagentTextStream();
		const result = stream.consume(
			`PI_SUBAGENT_ASYNC_JSON:${"x".repeat(33_000)}\nVisible\n`,
		);
		expect(result.visibleText).toBe("Visible\n");
		expect(result.statuses).toEqual([]);
	});
});
