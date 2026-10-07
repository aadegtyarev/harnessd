export type SubagentStatus = string;

export type SubagentLineResult = {
	readonly visibleText: string;
	readonly status?: SubagentStatus;
};

const MARKER = "PI_SUBAGENT_ASYNC_JSON:";
const ROLES = new Map([
	["scout", "Scout"],
	["worker", "Worker"],
	["reviewer", "Reviewer"],
	["researcher", "Researcher"],
]);
const STATES = new Map([
	["pending", "ожидает"],
	["queued", "ожидает"],
	["running", "выполняется"],
	["active", "выполняется"],
	["completed", "завершён"],
	["succeeded", "завершён"],
	["failed", "ошибка"],
	["error", "ошибка"],
	["stopped", "ошибка"],
]);

export function parseSubagentWidgetLine(line: string): SubagentLineResult {
	const candidate = line.trim().replace(/^Pi:\s*/, "");
	if (!candidate.startsWith(MARKER)) return { visibleText: line };
	try {
		const envelope: unknown = JSON.parse(candidate.slice(MARKER.length));
		if (
			!isRecord(envelope) ||
			envelope.kind !== "pi-subagents.async-status-snapshot"
		)
			return { visibleText: "" };
		if (!Array.isArray(envelope.runs)) return { visibleText: "" };
		const run = envelope.runs
			.filter((value) => isRecord(value) && value.kind === "subagent")
			.at(-1);
		if (!isRecord(run)) return { visibleText: "" };
		const label = typeof run.label === "string" ? run.label.toLowerCase() : "";
		const role = ROLES.get(label) ?? "Помощник";
		const state =
			typeof run.state === "string"
				? STATES.get(run.state.toLowerCase())
				: undefined;
		return {
			visibleText: "",
			status: state
				? `Задача ${role}: ${state}`
				: "Задача помощника: обновляется",
		};
	} catch {
		return { visibleText: "" };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
