import { meaningfulToolSummary } from "./telegram-activity-summary.js";

export type ActivityRow = {
	readonly id: string;
	summary: string;
	status: "running" | "done" | "failed";
};

export const MAX_EXACT_ACTIVITY_ROWS = 256;
export const OVERFLOW_ID = "__untracked_activity_overflow__";
export const OVERFLOW_SUMMARY =
	"Дополнительные операции не отслеживаются (достигнут предел)";

export function updateActivityRow(
	rows: ActivityRow[],
	id: string,
	summary: string | undefined,
	failed?: boolean,
): boolean {
	const existing = rows.find((row) => row.id === id);
	if (summary !== undefined) {
		if (!meaningfulToolSummary(summary)) return false;
		if (existing) {
			if (existing.status !== "running") return false;
			if (existing.summary === summary) return false;
			existing.summary = summary;
			return true;
		}
		if (rows.length < MAX_EXACT_ACTIVITY_ROWS) {
			rows.push({ id, summary, status: "running" });
			return true;
		}
		if (!rows.some((row) => row.id === OVERFLOW_ID))
			rows.push({
				id: OVERFLOW_ID,
				summary: OVERFLOW_SUMMARY,
				status: "running",
			});
		return false;
	}
	if (existing?.status !== "running" || failed === undefined) return false;
	existing.status = failed ? "failed" : "done";
	return true;
}
