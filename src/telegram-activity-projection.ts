import { truncateDiagnostic } from "./error-diagnostics.js";

export type ActivityRow = {
	readonly id: string;
	summary: string;
	status: "running" | "done" | "failed";
};

const MANAGEMENT_TOOL =
	/^(?:subagent(?:_|$)|agent_(?:list|wait|steer|resume|status|control)$)/i;

export function meaningfulToolSummary(summary: string): boolean {
	const normalized = summary.trim();
	if (!normalized) return false;
	if (/^subagent\s*·\s*workflow(?:\s*·|$)/i.test(normalized)) return false;
	const toolName = normalized.split(/[\s:·]/, 1)[0] ?? "";
	return !MANAGEMENT_TOOL.test(toolName);
}

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
		rows.push({ id, summary, status: "running" });
		return true;
	}
	if (existing?.status !== "running" || failed === undefined) return false;
	existing.status = failed ? "failed" : "done";
	return true;
}

export function visibleActivityRows(rows: readonly ActivityRow[]): string[] {
	const ranked = rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index);
	const visible = ranked.slice(0, 6);
	const lines = visible.map(
		({ row }) =>
			`• ${truncateDiagnostic(row.summary, 120)} ${row.status === "running" ? "…" : row.status === "failed" ? "❌" : "✓"}`,
	);
	const omitted = ranked.length - visible.length;
	if (omitted > 0) lines.push(`• Ещё завершено: ${omitted}`);
	return lines;
}

function rank(row: ActivityRow): number {
	return row.status === "running" ? 0 : row.status === "failed" ? 1 : 2;
}

export function localActivityTime(date: Date): string {
	return new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(date);
}
