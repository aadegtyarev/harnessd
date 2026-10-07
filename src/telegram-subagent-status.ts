export const MAX_SUBAGENT_ENVELOPE_CHARS = 32_768;

export type SubagentLineResult = {
	readonly matched: boolean;
	readonly status?: string;
};

const MARKER = "PI_SUBAGENT_ASYNC_JSON:";
const ROLES: Readonly<Record<string, string>> = {
	scout: "Scout",
	worker: "Worker",
	reviewer: "Reviewer",
	researcher: "Researcher",
};
const STATES: Readonly<Record<string, string>> = {
	pending: "ожидает",
	queued: "ожидает",
	running: "выполняется",
	active: "выполняется",
	completed: "завершён",
	succeeded: "завершён",
	failed: "ошибка",
	error: "ошибка",
	stopped: "ошибка",
};

export function parseSubagentWidgetLine(line: string): SubagentLineResult {
	const candidate = line.trim().replace(/^Pi:\s*/, "");
	if (!candidate.startsWith(MARKER)) return { matched: false };
	try {
		const envelope: unknown = JSON.parse(candidate.slice(MARKER.length));
		if (
			!isRecord(envelope) ||
			envelope.kind !== "pi-subagents.async-status-snapshot" ||
			!Array.isArray(envelope.runs)
		)
			return { matched: true };
		const run = envelope.runs
			.filter((value) => isRecord(value) && value.kind === "subagent")
			.at(-1);
		if (!isRecord(run)) return { matched: true };
		const label = typeof run.label === "string" ? run.label.toLowerCase() : "";
		const state =
			typeof run.state === "string"
				? STATES[run.state.toLowerCase()]
				: undefined;
		return {
			matched: true,
			status: state
				? `Задача ${ROLES[label] ?? "Помощник"}: ${state}`
				: "Задача помощника: обновляется",
		};
	} catch {
		return { matched: true };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
