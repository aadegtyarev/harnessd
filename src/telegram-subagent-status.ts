export const MAX_SUBAGENT_ENVELOPE_CHARS = 32_768;

export type SubagentLineResult = {
	readonly matched: boolean;
	readonly status?: string;
	readonly statuses?: readonly string[];
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
	if (!candidate.startsWith(MARKER)) return { matched: false };
	try {
		const envelope: unknown = JSON.parse(candidate.slice(MARKER.length));
		if (
			!isRecord(envelope) ||
			envelope.kind !== "pi-subagents.async-status-snapshot" ||
			!Array.isArray(envelope.runs)
		)
			return { matched: true };
		const latestByRole = new Map<string, string>();
		for (const run of envelope.runs) {
			if (!isRecord(run) || run.kind !== "subagent") continue;
			const label =
				typeof run.label === "string" ? run.label.toLowerCase() : "";
			const role = ROLES.get(label);
			const state =
				typeof run.state === "string"
					? STATES.get(run.state.toLowerCase())
					: undefined;
			if (role && state) latestByRole.set(role, `Задача ${role}: ${state}`);
		}
		const statuses = [...latestByRole.values()];
		return {
			matched: true,
			...(statuses.length ? { status: statuses.at(-1), statuses } : {}),
		};
	} catch {
		return { matched: true };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
