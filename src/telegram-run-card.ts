/** Live run card: one Telegram message that shows where a run is heading. */

export type RunCardEventState = "running" | "done" | "failed";

export type RunCardEvent = {
	/** Tool call ID, or a synthetic key for thoughts. */
	readonly id: string;
	/** Collapse key: consecutive events with the same key merge into one row. */
	readonly kind: string;
	at: string;
	text: string;
	state?: RunCardEventState;
	detail?: string;
	startedAtMs?: number;
	durationMs?: number;
	count: number;
};

export type RunCardTask = {
	readonly goal: string;
	readonly progress?: string;
	readonly status: string;
	readonly step: number;
	readonly limit?: number;
};

export const RUN_CARD_EVENT_HISTORY = 40;
export const RUN_CARD_VISIBLE_EVENTS = 5;
const COLLAPSIBLE = new Set(["read", "grep", "find", "ls", "edit", "write"]);

/** Tool kind used for icons and collapsing, from a harness tool summary. */
export function toolKind(summary: string): string {
	return /^([a-z_][\w-]*)(?::|\s|$)/i.exec(summary)?.[1]?.toLowerCase() ?? "";
}

/** Appends a tool start, collapsing consecutive same-kind reads/edits/searches. */
export function addToolEvent(
	events: RunCardEvent[],
	id: string,
	summary: string,
	at: string,
	nowMs: number,
): boolean {
	const existing = events.find((event) => event.id === id);
	if (existing) {
		// Repeated starts for one call only refresh its text.
		if (existing.state !== "running" || existing.text === summary) return false;
		existing.text = summary;
		return true;
	}
	const kind = toolKind(summary);
	const last = events.at(-1);
	if (
		last &&
		COLLAPSIBLE.has(kind) &&
		last.kind === kind &&
		last.state !== "failed"
	) {
		Object.assign(last, {
			id,
			at,
			text: summary,
			state: "running",
			startedAtMs: nowMs,
			count: last.count + 1,
		});
		last.detail = undefined;
		last.durationMs = undefined;
		return true;
	}
	events.push({
		id,
		kind,
		at,
		text: summary,
		state: "running",
		startedAtMs: nowMs,
		count: 1,
	});
	if (events.length > RUN_CARD_EVENT_HISTORY) events.shift();
	return true;
}

export function finishToolEvent(
	events: RunCardEvent[],
	id: string,
	failed: boolean,
	detail: string | undefined,
	nowMs: number,
): boolean {
	const event = events.find((candidate) => candidate.id === id);
	if (event?.state !== "running") return false;
	event.state = failed ? "failed" : "done";
	if (detail) event.detail = detail;
	if (event.startedAtMs !== undefined)
		event.durationMs = nowMs - event.startedAtMs;
	return true;
}

export function addThoughtEvent(
	events: RunCardEvent[],
	text: string,
	at: string,
): void {
	const last = events.at(-1);
	if (last?.kind === "thought" && last.text === text) return;
	events.push({
		id: `thought:${events.length}:${text}`,
		kind: "thought",
		at,
		text,
		count: 1,
	});
	if (events.length > RUN_CARD_EVENT_HISTORY) events.shift();
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}с`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}м${seconds % 60 ? ` ${seconds % 60}с` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}ч${minutes % 60 ? ` ${minutes % 60}м` : ""}`;
}

function clip(text: string, limit: number): string {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length > limit
		? `${chars.slice(0, limit - 1).join("")}…`
		: chars.join("");
}

const ICONS: Record<string, string> = {
	bash: "$",
	read: "📖",
	edit: "✏️",
	write: "✏️",
	grep: "🔎",
	find: "🔎",
	ls: "📂",
	subagent: "🚀",
};

export function formatRunCardEvent(event: RunCardEvent): string {
	if (event.kind === "thought")
		return `${event.at} 💭 ${clip(event.text, 160)}`;
	const kind = event.kind;
	let text = event.text;
	if (kind === "bash") text = text.replace(/^bash:\s*/, "");
	else if (ICONS[kind] && kind !== "subagent")
		text = text.replace(/^[a-z_]+:\s*/i, "");
	const icon = ICONS[kind] ? `${ICONS[kind]} ` : "";
	const count = event.count > 1 ? `${event.count}× ` : "";
	const duration =
		event.durationMs !== undefined && event.durationMs >= 1000
			? ` · ${formatDuration(event.durationMs)}`
			: "";
	const outcome =
		event.state === "running"
			? " …"
			: kind === "bash" && event.detail
				? ` → ${event.detail.replace(/^exit /, "")}${duration}`
				: event.state === "failed"
					? ` ❌${duration}`
					: event.state === "done"
						? ` ✓${duration}`
						: "";
	return `${event.at} ${icon}${count}${clip(text, 110)}${outcome}`;
}

export type RunCardInput = {
	readonly stateIcon: string;
	readonly status: string;
	readonly sessionLabel: string;
	readonly elapsedMs?: number;
	readonly task?: RunCardTask;
	readonly thought?: string;
	readonly notices: readonly string[];
	readonly events: readonly RunCardEvent[];
	readonly footer: string;
};

export function renderRunCard(input: RunCardInput): string {
	// Minute resolution keeps the card from being re-edited every second.
	const elapsed =
		input.elapsedMs !== undefined && input.elapsedMs >= 60_000
			? ` · ${formatDuration(Math.floor(input.elapsedMs / 60_000) * 60_000)}`
			: "";
	const lines = [
		`${input.stateIcon} Ход · ${input.status} · ${input.sessionLabel}${elapsed}`,
	];
	if (input.task) {
		const step =
			input.task.limit !== undefined
				? ` · шаг ${input.task.step}/${input.task.limit}`
				: input.task.step
					? ` · шаг ${input.task.step}`
					: "";
		const blocked =
			input.task.status === "blocked" ? " · ❓ ждёт вашего ответа" : "";
		lines.push(`🎯 ${clip(input.task.goal, 140)}${step}${blocked}`);
		if (input.task.progress) lines.push(`📝 ${clip(input.task.progress, 240)}`);
	}
	if (input.thought) lines.push(`💭 ${clip(input.thought, 160)}`);
	for (const notice of input.notices) lines.push(`• ${clip(notice, 180)}`);
	const visible = input.events.slice(-RUN_CARD_VISIBLE_EVENTS);
	if (visible.length) {
		const hidden = input.events.length - visible.length;
		lines.push("", `🕘 События${hidden ? ` (ещё ${hidden} раньше)` : ""}`);
		lines.push(...visible.map(formatRunCardEvent));
	}
	lines.push("", input.footer);
	return lines.join("\n");
}

/** Card header icon: needs-you and waiting win over plain working. */
export function runCardStateIcon(options: {
	readonly finished?: "done" | "failed";
	readonly task?: RunCardTask;
	readonly events: readonly RunCardEvent[];
}): string {
	if (options.finished === "done") return "✅";
	if (options.finished === "failed") return "⛔";
	if (options.task?.status === "blocked") return "❓";
	const running = options.events.filter((event) => event.state === "running");
	if (running.some((event) => event.text.startsWith("⏸"))) return "⏸";
	return "⏳";
}
