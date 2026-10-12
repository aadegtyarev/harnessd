/** Agents section of the run card, built from pi-subagents async status snapshots. */

const MARKER = "PI_SUBAGENT_ASYNC_JSON:";
const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
/** The producer caps the serialized JSON at 32 KiB; allow headroom for encoding. */
const MAX_ENVELOPE_JSON_CHARS = 65_536;
export const AGENT_BOARD_ROWS = 6;
const MAX_DEPTH = 3;
const MAX_CHILDREN = 16;
const MAX_WAIT_NAMES = 3;
export const MAX_AGENT_VERDICTS = 24;

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

export type AgentSnapshot = {
	readonly runs: readonly AgentRun[];
	/** Runs/children the producer omitted because of its own caps. */
	readonly omitted: number;
};

/** Outcome of one finished run, taken from the parent's completion notice. */
export type AgentVerdict = {
	readonly agent: string;
	/** Run ID from the notice's correlation lines, when it carries one. */
	readonly runId?: string;
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
	const label = text(node.label, 120);
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
		id: text(node.id, 64) ?? "",
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
export function latestAgentSnapshot(source: string): AgentSnapshot | undefined {
	let latest: AgentSnapshot | undefined;
	for (const line of source.split("\n")) {
		const candidate = line.trim().replace(/^Pi:\s*/, "");
		if (!candidate.startsWith(MARKER)) continue;
		const json = candidate.slice(MARKER.length);
		if (json.length > MAX_ENVELOPE_JSON_CHARS) continue;
		try {
			const envelope = JSON.parse(json) as {
				kind?: unknown;
				runs?: unknown;
				omitted?: { runs?: unknown; children?: unknown };
			};
			if (envelope.kind !== SNAPSHOT_KIND || !Array.isArray(envelope.runs))
				continue;
			const omitted =
				(time(envelope.omitted?.runs) ?? 0) +
				(time(envelope.omitted?.children) ?? 0);
			latest = {
				runs: envelope.runs
					.map((run) => parseNode(run, 0))
					.filter((run): run is AgentRun => run !== undefined),
				omitted,
			};
		} catch {
			// Malformed envelopes are ignored; the next snapshot replaces the board.
		}
	}
	return latest;
}

/** Verdict of one review block: whole-word tokens near a review/verdict heading. */
function reviewVerdict(block: string): { verdict: string; finding?: string } {
	const heading = /^#{1,3}[^\n]*\b(?:review|verdict)/im.exec(block);
	if (!heading) return { verdict: "готово" };
	const window = block.slice(heading.index, heading.index + 600);
	const rejected = /\bREQUEST_CHANGES\b/.exec(window)?.index ?? -1;
	const approved = /\bAPPROVE\b(?![D_])/.exec(window)?.index ?? -1;
	const verdict =
		rejected >= 0 && (approved < 0 || rejected < approved)
			? "REQUEST_CHANGES"
			: approved >= 0
				? "APPROVE"
				: "готово";
	const finding = /^\s*-\s*\*\*(P[0-3][^*]*)\*\*/m.exec(
		block.slice(heading.index),
	)?.[1];
	return { verdict, ...(finding ? { finding: text(finding, 80) } : {}) };
}

const NOTICE_STATES: Record<string, string> = {
	failed: "ошибка",
	paused: "пауза",
	stopped: "остановлен",
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run ID of one notice block: the async directory name or the workflow run. */
function noticeRunId(block: string): string | undefined {
	const workflow = /^Workflow run: (\S+)\s*$/m.exec(block)?.[1];
	if (workflow) return workflow;
	const dir = /^Retention-managed async directory: (.+?)\s*$/m.exec(block)?.[1];
	const name = dir?.split(/[\\/]/).filter(Boolean).at(-1);
	return name && !name.endsWith("…") ? name : undefined;
}

function noticeVerdict(agent: string, block: string): AgentVerdict {
	const runId = noticeRunId(block);
	return { agent, ...(runId ? { runId } : {}), ...reviewVerdict(block) };
}

/**
 * Parses pi-subagents completion notices: single and detached notices
 * ("Background task completed: **reviewer**") and grouped ones
 * ("Background tasks completed (2): **a**, **b**" with "N. agent" blocks).
 * Grouped blocks are split only at the "N. name" lines the header names, so
 * numbered lists inside a result preview stay in their block.
 */
export function agentVerdicts(notice: string): AgentVerdict[] {
	const single =
		/^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*([^*]+)\*\*/.exec(
			notice,
		);
	if (single?.[1] && single[2]) {
		const agent = single[2].trim();
		if (single[1] === "completed") return [noticeVerdict(agent, notice)];
		const runId = noticeRunId(notice);
		return [
			{
				agent,
				...(runId ? { runId } : {}),
				verdict: NOTICE_STATES[single[1]] ?? single[1],
			},
		];
	}
	const header = /^Background tasks completed \(\d+\): ([^\n]*)/.exec(notice);
	if (!header?.[1]) return [];
	const names = [...header[1].matchAll(/\*\*([^*]+)\*\*/g)].map((match) =>
		(match[1] as string).trim(),
	);
	const starts: number[] = [];
	let from = header[0].length;
	for (const [index, name] of names.entries()) {
		// Blocks follow a blank line; the header line is "N. name", optionally
		// followed by task info or a schedule note, never by free text.
		const marker = new RegExp(
			`\\n\\n${index + 1}\\. ${escapeRegExp(name)}(?: ?\\(| — |\\n|$)`,
			"g",
		);
		marker.lastIndex = from;
		const match = marker.exec(notice);
		if (!match) break;
		starts.push(match.index);
		from = match.index + match[0].length;
	}
	return starts.map((start, index) =>
		noticeVerdict(
			names[index] as string,
			notice.slice(start, starts[index + 1] ?? notice.length),
		),
	);
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
export function shortRunId(run: Pick<AgentRun, "id" | "kind">): string {
	return run.kind !== "step" && /^[0-9a-f]{8}/i.test(run.id)
		? run.id.slice(0, 8)
		: "";
}

function isActive(run: AgentRun): boolean {
	return run.state === "running" || run.state === "queued";
}

function asks(run: AgentRun): boolean {
	return isActive(run) && run.needsAttention;
}

/** 0 = asks the parent somewhere in the subtree, 1 = active, 2 = finished. */
function rank(run: AgentRun): number {
	if (asks(run) || run.children.some((child) => rank(child) === 0)) return 0;
	return isActive(run) || run.children.some(isActive) ? 1 : 2;
}

function byRank(left: AgentRun, right: AgentRun): number {
	return (
		rank(left) - rank(right) ||
		(right.endedAt ?? right.startedAt ?? 0) -
			(left.endedAt ?? left.startedAt ?? 0)
	);
}

function countNodes(runs: readonly AgentRun[]): number {
	return runs.reduce((sum, run) => sum + 1 + countNodes(run.children), 0);
}

function allNodes(run: AgentRun): AgentRun[] {
	return [run, ...run.children.flatMap(allNodes)];
}

function agentNames(label: string): string[] {
	return label
		.replace(/…$/, "")
		.split(/,\s*/)
		.map((name) => name.trim())
		.filter(Boolean);
}

/**
 * Pairs verdicts with finished runs by the run ID the notice carries. A notice
 * without an ID falls back to the agent name, and only when exactly one
 * unpaired finished run and one such notice share that name, so an ambiguous
 * pairing shows no verdict instead of a wrong one.
 */
export function assignVerdicts(
	runs: readonly AgentRun[],
	verdicts: readonly AgentVerdict[],
): Map<AgentRun, AgentVerdict> {
	const assigned = new Map<AgentRun, AgentVerdict>();
	const finished = runs.flatMap(allNodes).filter((run) => !isActive(run));
	const unpaired: AgentVerdict[] = [];
	for (const verdict of verdicts) {
		const run = verdict.runId
			? finished.find((candidate) => candidate.id === verdict.runId)
			: undefined;
		if (run) assigned.set(run, verdict);
		else if (!verdict.runId) unpaired.push(verdict);
	}
	for (const agent of new Set(unpaired.map((verdict) => verdict.agent))) {
		const forAgent = unpaired.filter((verdict) => verdict.agent === agent);
		const matching = finished.filter(
			(run) =>
				!assigned.has(run) &&
				run.kind !== "workflow" &&
				agentNames(run.label).includes(agent),
		);
		const [run] = matching;
		const [verdict] = forAgent;
		if (run && verdict && matching.length === 1 && forAgent.length === 1)
			assigned.set(run, verdict);
	}
	return assigned;
}

/** First descendant that asks the parent, if any. */
function askingDescendant(run: AgentRun): AgentRun | undefined {
	for (const child of run.children) {
		if (asks(child)) return child;
		const deeper = askingDescendant(child);
		if (deeper) return deeper;
	}
	return undefined;
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
	depth: number,
	nowMs: number,
	verdicts: ReadonlyMap<AgentRun, AgentVerdict>,
): string {
	// A run whose step asks is itself waiting on an answer, even when the step row is cut.
	const asking = asks(run) ? undefined : askingDescendant(run);
	const icon = asks(run) || asking ? "❓" : (STATE_ICONS[run.state] ?? "•");
	const id = shortRunId(run) ? ` #${shortRunId(run)}` : "";
	let detail = "";
	if (asks(run)) detail = " · спрашивает родителя";
	else if (asking) detail = ` · ${text(asking.label, 32)} спрашивает родителя`;
	else if (isActive(run)) {
		if (run.currentTool) detail += ` · ${run.currentTool}`;
		if (run.toolCount) detail += ` · ${run.toolCount} выз.`;
	} else {
		const verdict = verdicts.get(run);
		if (verdict && verdict.verdict !== "готово")
			detail = ` · ${verdict.verdict}${verdict.finding ? `: ${verdict.finding}` : ""}`;
	}
	const indent = depth ? "   ↳ " : "";
	const label = text(run.label, 48) ?? run.label;
	return `${indent}${icon} ${label}${id}${elapsedLabel(run, nowMs)}${detail}`;
}

export type AgentBoardOptions = {
	readonly verdicts?: readonly AgentVerdict[];
	/** Short IDs named by a running wait. */
	readonly waitingFor?: readonly string[];
	/** A running wait without IDs waits for every active agent. */
	readonly waitsForAll?: boolean;
	/** Finished runs that ended before this moment are left out (earlier turns). */
	readonly finishedSince?: number;
};

/**
 * Renders at most six rows. Every top-level run gets a row before any step does;
 * steps then fill the remaining rows in rank order (asking parent, active, recent).
 * The hidden count covers cut rows, deeper levels, and producer-side omissions.
 */
export function renderAgentBoard(
	snapshot: AgentSnapshot,
	nowMs: number,
	options: AgentBoardOptions = {},
): string[] {
	// Finished runs that ended before this turn belong to earlier turns; unknown times stay.
	const runs = snapshot.runs.filter((run) => {
		const at = run.endedAt ?? run.startedAt;
		return (
			rank(run) < 2 ||
			options.finishedSince === undefined ||
			at === undefined ||
			at >= options.finishedSince
		);
	});
	if (runs.length === 0) return [];
	const verdicts = assignVerdicts(runs, options.verdicts ?? []);
	const top = [...runs].sort(byRank);
	const shownTop = top.slice(0, AGENT_BOARD_ROWS);
	// Steps are ranked by their own subtree, so an asking grandchild lifts its step.
	const shownChildren = shownTop
		.flatMap((run) => run.children.map((child) => ({ parent: run, child })))
		.sort((left, right) => byRank(left.child, right.child))
		.slice(0, Math.max(0, AGENT_BOARD_ROWS - shownTop.length));
	const lines: string[] = [];
	for (const run of shownTop) {
		lines.push(runLine(run, 0, nowMs, verdicts));
		for (const { parent, child } of shownChildren)
			if (parent === run) lines.push(runLine(child, 1, nowMs, verdicts));
	}
	const hidden =
		countNodes(runs) -
		shownTop.length -
		shownChildren.length +
		snapshot.omitted;
	const activeAgents = runs
		.flatMap(allNodes)
		.filter((run) => run.kind !== "workflow" && isActive(run)).length;
	const header = `🤖 Агенты${
		activeAgents
			? ` · ${activeAgents} ${activeAgents === 1 ? "работает" : "работают"}${activeAgents > 1 ? " параллельно" : ""}`
			: ""
	}`;
	const board = [header, ...lines];
	if (hidden > 0) board.push(`… ещё ${hidden}`);
	const waiting = options.waitsForAll
		? top
				.filter(isActive)
				.map((run) =>
					shortRunId(run) ? `${run.label} #${shortRunId(run)}` : run.label,
				)
		: [...(options.waitingFor ?? [])];
	if (options.waitsForAll && waiting.length === 0) waiting.push("всех агентов");
	if (waiting.length) {
		const names = waiting
			.slice(0, MAX_WAIT_NAMES)
			.map((name) => text(name, 40) ?? name);
		const more = waiting.length - MAX_WAIT_NAMES;
		board.push(
			`⏸ родитель ждёт: ${names.join(", ")}${more > 0 ? ` и ещё ${more}` : ""}`,
		);
	}
	return board;
}
