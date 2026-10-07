import { afterEach, describe, expect, it } from "vitest";
import {
	type ActivityRow,
	localActivityTime,
	updateActivityRow,
	visibleActivityRows,
} from "../src/telegram-activity-projection.js";

afterEach(() => {
	process.env.TZ = "UTC";
});

describe("Telegram activity projection", () => {
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

	it("bounds child slots and tools together, prioritizing active and failed states", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < 5; i++) {
			updateActivityRow(rows, `done-${i}`, `read: ${i}`);
			updateActivityRow(rows, `done-${i}`, undefined, false);
		}
		updateActivityRow(rows, "active", "bash: active");
		updateActivityRow(rows, "failed", "bash: failed");
		updateActivityRow(rows, "failed", undefined, true);
		const children = new Map([["Worker", "Задача Worker: выполняется"]]);
		const lines = visibleActivityRows(rows, children);
		expect(lines).toHaveLength(7);
		expect(lines).toContain("• Задача Worker: выполняется …");
		expect(lines).toContain("• bash: active …");
		expect(lines).toContain("• bash: failed ❌");
		expect(lines.at(-1)).toBe("• Ещё завершено: 2");
	});

	it("projects approved role labels without exposing task text or internal IDs", () => {
		const rows: ActivityRow[] = [];
		updateActivityRow(rows, "private-id", "subagent · worker · SECRET_SUFFIX");
		const lines = visibleActivityRows(rows);
		expect(lines).toEqual(["• Задача Worker: выполняется …"]);
		const coalesced = visibleActivityRows(
			rows,
			new Map([["Worker", "Задача Worker: завершён"]]),
		);
		expect(coalesced).toEqual(["• Задача Worker: завершён ✓"]);
		expect(coalesced.join(" ")).not.toContain("SECRET_SUFFIX");
		expect(coalesced.join(" ")).not.toContain("private-id");
	});

	it("retains a bounded exact-call window", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < 60; i++)
			updateActivityRow(rows, `id-${i}`, `read: ${i}`);
		expect(rows).toHaveLength(40);
		expect(rows[0]?.id).toBe("id-20");
	});

	it("reports omitted running and failed operations without calling them completed", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < 7; i++)
			updateActivityRow(rows, `run-${i}`, `bash: ${i}`);
		updateActivityRow(rows, "failed", "bash: failed");
		updateActivityRow(rows, "failed", undefined, true);
		const lines = visibleActivityRows(rows);
		expect(lines).toContain("• Ещё выполняется: 1");
		expect(lines).toContain("• Ещё ошибок: 1");
		expect(lines).not.toContain("• Ещё завершено: 2");
	});

	it("formats local wall-clock time using the host timezone", () => {
		process.env.TZ = "America/New_York";
		expect(localActivityTime(new Date("2024-01-01T12:34:56.000Z"))).toBe(
			"07:34:56",
		);
	});
});
