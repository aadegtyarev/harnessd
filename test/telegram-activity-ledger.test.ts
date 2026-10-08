import { describe, expect, it } from "vitest";
import {
	type ActivityRow,
	MAX_EXACT_ACTIVITY_ROWS,
	updateActivityRow,
} from "../src/telegram-activity-ledger.js";

describe("Telegram activity ledger", () => {
	it("updates one exact tool call and ignores duplicates, regressions, and unknown ends", () => {
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

	it("retains terminal IDs and exact status after many ends", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < 60; i++)
			updateActivityRow(rows, `id-${i}`, `read: ${i}`);
		for (let i = 0; i < 60; i++)
			updateActivityRow(rows, `id-${i}`, undefined, false);
		expect(rows).toHaveLength(60);
		expect(rows.every((row) => row.status === "done")).toBe(true);
		expect(updateActivityRow(rows, "id-0", "read: regression")).toBe(false);
	});

	it("bounds exact rows and keeps overflow explicit without losing known ends", () => {
		const rows: ActivityRow[] = [];
		for (let i = 0; i < MAX_EXACT_ACTIVITY_ROWS; i++)
			expect(updateActivityRow(rows, `id-${i}`, `read: ${i}`)).toBe(true);
		expect(
			updateActivityRow(
				rows,
				`id-${MAX_EXACT_ACTIVITY_ROWS}`,
				"read: overflow",
			),
		).toBe(true);
		expect(
			updateActivityRow(
				rows,
				`id-${MAX_EXACT_ACTIVITY_ROWS + 1}`,
				"read: overflow",
			),
		).toBe(false);
		expect(
			rows.filter(
				(row) => row.id.startsWith("id-") && row.status === "running",
			),
		).toHaveLength(MAX_EXACT_ACTIVITY_ROWS);
		expect(
			rows.some((row) => row.id === "__untracked_activity_overflow__"),
		).toBe(true);
		expect(
			updateActivityRow(
				rows,
				`id-${MAX_EXACT_ACTIVITY_ROWS - 1}`,
				undefined,
				false,
			),
		).toBe(true);
		expect(
			updateActivityRow(
				rows,
				`id-${MAX_EXACT_ACTIVITY_ROWS}`,
				undefined,
				false,
			),
		).toBe(false);
	});
});
