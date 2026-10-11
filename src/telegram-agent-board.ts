/** Agents section of the run card, built from pi-subagents async status snapshots. */

const MARKER = "PI_SUBAGENT_ASYNC_JSON:";
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
const MAX_ENVELOPE_CHARS = 32_768;
export const AGENT_BOARD_ROWS = 6;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 8;

export type AgentRun = {
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly state: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly currentTool?: string;
	readonly toolCount?: number;
	readonly needsAttention: boolean;
	readonly children: readonly AgentRun[];
};

/** Outcome of a finished run, taken from the parent's completion notice. */
export type AgentVerdict = {
	readonly agent: string;
	readonly verdict: string;
	readonly finding?: string;
};

function text(value: unknown, limit = 80): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	const chars = [...clean];
	return chars.length > limit
		? `${chars.slice(0, limit - 1).join("")}…`
		: clean;
}

function time(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseNode(value: unknown, depth: number): AgentRun | undefined {
	if (!value || typeof value !== "object") return undefined;
	const node = value as Record<string, unknown>;
	const id = text(node.id, 64) ?? "";
	const label = text(node.label, 48);
	const state = text(node.state, 24);
	if (!label || !state) return undefined;
	const activity = (node.activity ?? {}) as Record<string, unknown>;
	const children =
		depth < MAX_DEPTH && Array.isArray(node.children)
			? node.children
					.slice(0, MAX_CHILDREN)
					.map((child) => parseNode(child, depth + 1))
					.filter((child): child is AgentRun => child !== undefined)
			: [];
	const startedAt = time(node.startedAt);
	const endedAt = time(node.endedAt);
	const currentTool = text(activity.currentTool, 40);
	const toolCount = time(activity.toolCount);
	return {
		id,
		kind: text(node.kind, 16) ?? "subagent",
		label,
		state,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(currentTool ? { currentTool } : {}),
		...(toolCount !== undefined ? { toolCount } : {}),
		needsAttention: activity.state === "needs_attention",
		children,
	};
}

/** Latest snapshot carried by widget/notification text, if any. */
export function latestAgentSnapshot(source: string): AgentRun[] | undefined {
	let latest: AgentRun[] | undefined;
	for (const line of source.split("\n")) {
		const candidate = line.trim().replace(/^Pi:\s*/, "");
		if (!candidate.startsWith(MARKER) || candidate.length > MAX_ENVELOPE_CHARS)
			continue;
		try {
			const envelope = JSON.parse(candidate.slice(MARKER.length)) as {
				kind?: unknown;
				runs?: unknown;
			};
			if (envelope.kind !== SNAPSHOT_KIND || !Array.isArray(envelope.runs))
				continue;
			latest = envelope.runs
				.map((run) => parseNode(run, 0))
				.filter((run): run is AgentRun => run !== undefined);
		} catch {
			// Malformed envelopes are ignored; the next snapshot replaces the board.
		}
	}
	return latest;
}

/** Parses a pi-subagents completion notice ("Background task completed: **reviewer**"). */
export function agentVerdict(notice: string): AgentVerdict | undefined {
	const head =
		/^(?:Background task|Detached foreground task) completed: \*\*([^*]+)\*\*/.exec(
			notice,
		);
	if (!head?.[1]) return undefined;
	const agent = head[1].trim();
	const heading = /^#{1,3}[^\n]*\breview\b[^\n]*$/im.exec(notice);
	if (!heading) return { agent, verdict: "готово" };
	const window = notice.slice(heading.index, heading.index + 400);
	const rejected = window.indexOf("REQUEST_CHANGES");
	const approved = window.indexOf("APPROVE");
	const verdict =
		rejected >= 0 && (approved < 0 || rejected < approved)
			? "REQUEST_CHANGES"
			: approved >= 0
				? "APPROVE"
				: "готово";
	const finding = /^\s*-\s*\*\*(P[0-3][^*]*)\*\*/m.exec(notice)?.[1];
	return { agent, verdict, ...(finding ? { finding: text(finding, 80) } : {}) };
}

const STATE_ICONS: Record<string, string> = {
	queued: "⏳",
	running: "🟢",
	paused: "⏸",
	complete: "✅",
	completed: "✅",
	partial: "⚠️",
	failed: "❌",
	stopped: "⏹",
	rejected: "🚫",
};

/** First 8 characters of a generated (hex/UUID) run ID; other IDs are never shown. */
export function shortRunId(run: AgentRun): string {
	return run.kind !== "step" && /^[0-9a-f-]{8,}$/i.test(run.id)
		? run.id.slice(0, 8)
		: "";
}

function isActive(run: AgentRun): boolean {
	return (
		run.state === "running" || run.state === "queued" || run.needsAttention
	);
}

function elapsedLabel(run: AgentRun, nowMs: number): string {
	if (run.startedAt === undefined) return "";
	const ms = (run.endedAt ?? nowMs) - run.startedAt;
	const minutes = Math.floor(Math.max(0, ms) / 60_000);
	if (minutes < 1) return " · <1м";
	return minutes < 60
		? ` · ${minutes}м`
		: ` · ${Math.floor(minutes / 60)}ч ${minutes % 60}м`;
}

function runLine(
	run: AgentRun,
	nowMs: number,
	verdicts: ReadonlyMap<string, AgentVerdict>,
	indent: string,
): string {
	const icon = run.needsAttention ? "❓" : (STATE_ICONS[run.state] ?? "•");
	const id = shortRunId(run) ? ` #${shortRunId(run)}` : "";
	let detail = "";
	if (run.needsAttention) detail = " · спрашивает родителя";
	else if (isActive(run)) {
		if (run.currentTool) detail += ` · ${run.currentTool}`;
		if (run.toolCount) detail += ` · ${run.toolCount} выз.`;
	} else {
		const verdict = verdicts.get(run.id);
		if (verdict && verdict.verdict !== "готово")
			detail = ` · ${verdict.verdict}${verdict.finding ? `: ${verdict.finding}` : ""}`;
	}
	return `${indent}${icon} ${run.label}${id}${elapsedLabel(run, nowMs)}${detail}`;
}

/**
 * Renders at most six rows: active and attention-needing runs first, then the most
 * recently finished ones; workflow steps are indented under their parent.
 */
export function renderAgentBoard(
	runs: readonly AgentRun[],
	nowMs: number,
	verdictsByAgent: ReadonlyMap<string, AgentVerdict> = new Map(),
	waitingFor: readonly string[] = [],
): string[] {
	if (runs.length === 0) return [];
	// A notice names only the agent: it belongs to that agent's latest finished run.
	const verdicts = new Map<string, AgentVerdict>();
	for (const [agent, verdict] of verdictsByAgent) {
		const latest = runs
			.filter((run) => run.label === agent && !isActive(run))
			.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0))[0];
		if (latest) verdicts.set(latest.id, verdict);
	}
	const ordered = [...runs].sort((left, right) => {
		const rank = (run: AgentRun) =>
			run.needsAttention ? 0 : isActive(run) ? 1 : 2;
		return (
			rank(left) - rank(right) ||
			(right.endedAt ?? right.startedAt ?? 0) -
				(left.endedAt ?? left.startedAt ?? 0)
		);
	});
	const active = runs.filter(isActive).length;
	const lines = [
		`🤖 Агенты${active ? ` · ${active} ${active === 1 ? "работает" : "работают"}${active > 1 ? " параллельно" : ""}` : ""}`,
	];
	let rows = 0;
	let hidden = 0;
	for (const run of ordered) {
		if (rows >= AGENT_BOARD_ROWS) {
			hidden++;
			continue;
		}
		lines.push(runLine(run, nowMs, verdicts, ""));
		rows++;
		for (const child of run.children) {
			if (rows >= AGENT_BOARD_ROWS) break;
			lines.push(runLine(child, nowMs, verdicts, "   ↳ "));
			rows++;
		}
	}
	if (hidden) lines.push(`… ещё ${hidden}`);
	if (waitingFor.length)
		lines.push(`⏸ родитель ждёт: ${waitingFor.join(", ")}`);
	return lines;
}
