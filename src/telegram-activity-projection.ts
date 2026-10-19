import { truncateDiagnostic } from "./error-diagnostics.js";
import {
	type ActivityRow,
	OVERFLOW_ID,
	OVERFLOW_SUMMARY,
} from "./telegram-activity-ledger.js";
import {
	approvedSubagentRole,
	meaningfulToolSummary,
} from "./telegram-activity-summary.js";

export {
	type ActivityRow,
	MAX_EXACT_ACTIVITY_ROWS,
	updateActivityRow,
} from "./telegram-activity-ledger.js";
export { approvedSubagentRole, meaningfulToolSummary };

export function visibleActivityRows(
	rows: readonly ActivityRow[],
	children: ReadonlyMap<string, string> = new Map(),
): string[] {
	const byRole = new Map<string, ActivityRow>();
	const overflowed = rows.some((row) => row.id === OVERFLOW_ID);
	const operations: { summary: string; status: ActivityRow["status"] }[] = [];
	for (const row of rows) {
		if (row.id === OVERFLOW_ID) continue;
		const role = approvedSubagentRole(row.summary);
		if (role) {
			if (!children.has(role)) byRole.set(role, row);
			continue;
		}
		operations.push({ summary: row.summary, status: row.status });
	}
	for (const [role, row] of byRole) {
		const state =
			row.status === "failed"
				? "ошибка"
				: row.status === "done"
					? "завершён"
					: "выполняется";
		operations.push({
			summary: `Задача ${role}: ${state}`,
			status: row.status,
		});
	}
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
			`• ${truncateDiagnostic(row.summary, 120)}${row.status === "running" ? " …" : row.status === "failed" ? " ❌" : row.status === "done" ? " ✓" : ""}`,
	);
	const omitted = ranked.slice(6);
	const done = omitted.filter(
		({ row }) => row.status === "done" || row.status === "finished",
	).length;
	const running = omitted.filter(({ row }) => row.status === "running").length;
	const failed = omitted.filter(({ row }) => row.status === "failed").length;
	if (done) lines.push(`• Ещё завершено: ${done}`);
	if (running) lines.push(`• Ещё выполняется: ${running}`);
	if (failed) lines.push(`• Ещё ошибок: ${failed}`);
	if (overflowed) lines.push(`• ${OVERFLOW_SUMMARY}`);
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
