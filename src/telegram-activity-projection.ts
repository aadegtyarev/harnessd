import { truncateDiagnostic } from "./error-diagnostics.js";

export type ActivityRow = {
	readonly id: string;
	summary: string;
	status: "running" | "done" | "failed";
};

const MANAGEMENT_TOOL =
	/^(?:subagent(?:_|$)|agent_(?:list|wait|steer|resume|status|control)$)/i;
const APPROVED_ROLES = new Map([
	["scout", "Scout"],
	["worker", "Worker"],
	["reviewer", "Reviewer"],
	["researcher", "Researcher"],
]);
const MAX_RETAINED_ROWS = 40;

export function approvedSubagentRole(summary: string): string | undefined {
	const match = /^subagent\s*·\s*([^·\s]+)(?:\s*·|$)/i.exec(summary.trim());
	return match ? APPROVED_ROLES.get(match[1].toLowerCase()) : undefined;
}

export function meaningfulToolSummary(summary: string): boolean {
	const normalized = summary.trim();
	if (!normalized) return false;
	if (approvedSubagentRole(normalized)) return true;
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
		while (rows.length > MAX_RETAINED_ROWS) rows.shift();
		return true;
	}
	if (existing?.status !== "running" || failed === undefined) return false;
	existing.status = failed ? "failed" : "done";
	return true;
}

export function visibleActivityRows(
	rows: readonly ActivityRow[],
	children: ReadonlyMap<string, string> = new Map(),
): string[] {
	const operations: { summary: string; status: ActivityRow["status"] }[] =
		rows.flatMap((row) => {
			const role = approvedSubagentRole(row.summary);
			if (role && children.has(role)) return [];
			const state =
				row.status === "failed"
					? "ошибка"
					: row.status === "done"
						? "завершён"
						: "выполняется";
			return [
				{
					summary: role ? `Задача ${role}: ${state}` : row.summary,
					status: row.status,
				},
			];
		});
	for (const [_role, summary] of children) {
		const state = /: (завершён|ошибка)$/.exec(summary)?.[1];
		operations.push({
			summary,
			status: state === "ошибка" ? "failed" : state ? "done" : "running",
		});
	}
	const ranked = operations
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index);
	const visible = ranked.slice(0, 6);
	const lines = visible.map(
		({ row }) =>
			`• ${truncateDiagnostic(row.summary, 120)} ${row.status === "running" ? "…" : row.status === "failed" ? "❌" : "✓"}`,
	);
	const omitted = ranked.slice(6);
	const done = omitted.filter(({ row }) => row.status === "done").length;
	const running = omitted.filter(({ row }) => row.status === "running").length;
	const failed = omitted.filter(({ row }) => row.status === "failed").length;
	if (done) lines.push(`• Ещё завершено: ${done}`);
	if (running) lines.push(`• Ещё выполняется: ${running}`);
	if (failed) lines.push(`• Ещё ошибок: ${failed}`);
	return lines;
}

function rank(row: { status: ActivityRow["status"] }): number {
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
