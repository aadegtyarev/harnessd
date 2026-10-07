import { describe, expect, it } from "vitest";
import { parseSubagentWidgetLine } from "../src/telegram-subagent-status.js";

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
});
