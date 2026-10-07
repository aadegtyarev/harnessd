import { afterEach, describe, expect, it } from "vitest";
import {
	type ActivityRow,
	localActivityTime,
	meaningfulToolSummary,
	updateActivityRow,
	visibleActivityRows,
} from "../src/telegram-activity-projection.js";

afterEach(() => {
	process.env.TZ = "UTC";
});

describe("Telegram activity projection", () => {
	it("suppresses generic workflow and subagent management plumbing", () => {
		expect(meaningfulToolSummary("subagent · workflow · inspect")).toBe(false);
		expect(meaningfulToolSummary("subagent_wait: worker")).toBe(false);
		expect(meaningfulToolSummary("bash: npm test")).toBe(true);
	});

	it("replaces an exact tool call in one row and ignores duplicates, regressions, and unknown ends", () => {
		const rows: ActivityRow[] = [];
		expect(updateActivityRow(rows, "opaque", "bash: npm test")).toBe(true);
		expect(updateActivityRow(rows, "opaque", "bash: npm test")).toBe(false);
		expect(updateActivityRow(rows, "unknown", undefined, false)).toBe(false);
		expect(updateActivityRow(rows, "opaque", undefined, false)).toBe(true);
		expect(updateActivityRow(rows, "opaque", "bash: npm test")).toBe(false);
		expect(rows).toEqual([
			{ id: "opaque", summary: "bash: npm test", status: "done" },
		]);
	});

	it("bounds visible rows, prioritizes active and failed operations, and counts omitted meaningful rows", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < 8; i++)
			updateActivityRow(rows, String(i), `read: ${i}`);
		updateActivityRow(rows, "0", undefined, false);
		updateActivityRow(rows, "1", undefined, true);
		for (let i = 2; i < 8; i++)
			updateActivityRow(rows, String(i), undefined, false);
		updateActivityRow(rows, "8", "bash: active");
		const visible = visibleActivityRows(rows);
		expect(visible).toHaveLength(7);
		expect(visible[0]).toContain("bash: active …");
		expect(visible[1]).toContain("read: 1 ❌");
		expect(visible.at(-1)).toBe("• Ещё завершено: 3");
	});

	it("formats local wall-clock time using the host timezone", () => {
		process.env.TZ = "America/New_York";
		expect(localActivityTime(new Date("2024-01-01T12:34:56.000Z"))).toBe(
			"07:34:56",
		);
	});
});
