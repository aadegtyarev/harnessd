import type { HarnessActivityEvent } from "../core/types.js";
import { redactDiagnosticText } from "../error-diagnostics.js";

const THOUGHT_LIMIT = 160;
const TASK_TEXT_LIMIT = 240;
const TASK_ENTRY_TYPE = "pi-ad-hooks-task";

function clip(text: string, limit: number): string {
	const chars = [...text];
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Reduces a thinking block to one line: the last bold reasoning-summary title
 * (the form OpenAI reasoning summaries take), otherwise the first sentence.
 * Full reasoning text is never returned.
 */
export function thoughtSummary(content: string): string | undefined {
	const titles = [...content.matchAll(/\*\*([^*\n]+?)\*\*/g)].map((match) =>
		oneLine(match[1] ?? ""),
	);
	const title = titles.filter(Boolean).at(-1);
	const plain = oneLine(content.replace(/[*`#>]/g, ""));
	const firstSentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
	const summary = title ?? firstSentence;
	if (!summary) return undefined;
	return clip(redactDiagnosticText(summary), title ? THOUGHT_LIMIT : 120);
}

function resultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/** Exit status of a bash tool result ("exit 0", "exit 2", or "error"). */
export function bashExitDetail(result: unknown, isError: boolean): string {
	const code = /Command exited with code (-?\d+)/i.exec(
		resultText(result),
	)?.[1];
	return code !== undefined ? `exit ${code}` : isError ? "error" : "exit 0";
}

/** Pi /task state from an `entry_appended` record, if it carries one. */
export function taskActivity(
	entry: unknown,
): Extract<HarnessActivityEvent, { type: "task" }> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { customType?: unknown; data?: unknown };
	if (record.customType !== TASK_ENTRY_TYPE || !record.data) return undefined;
	const data = record.data as Record<string, unknown>;
	if (typeof data.goal !== "string" || typeof data.status !== "string")
		return undefined;
	const progress =
		typeof data.progress === "string" && data.progress.trim()
			? clip(redactDiagnosticText(oneLine(data.progress)), TASK_TEXT_LIMIT)
			: undefined;
	return {
		type: "task",
		goal: clip(redactDiagnosticText(oneLine(data.goal)), TASK_TEXT_LIMIT),
		...(progress ? { progress } : {}),
		status: data.status,
		step: typeof data.continuations === "number" ? data.continuations : 0,
		...(typeof data.continuationLimit === "number"
			? { limit: data.continuationLimit }
			: {}),
	};
}

function shortId(value: unknown): string {
	return typeof value === "string" && value ? `#${value.slice(0, 8)}` : "";
}

/** Plain-language summaries for subagent coordination tools. */
export function coordinationSummary(
	name: string,
	args: Record<string, unknown>,
): string | undefined {
	if (name === "bg_wait") {
		const minutes =
			typeof args.timeoutMs === "number"
				? ` (до ${Math.max(1, Math.round(args.timeoutMs / 60_000))} мин)`
				: "";
		return (
			["⏸ ждёт агентов", shortId(args.id)].filter(Boolean).join(" ") + minutes
		);
	}
	if (name !== "subagent" || typeof args.action !== "string") return undefined;
	const target = shortId(args.id);
	const labels: Record<string, string> = {
		status: "🔎 проверяет статус агента",
		steer: "📨 отправил указание агенту",
		resume: "▶ возобновил агента",
		stop: "⏹ остановил агента",
		list: "🔎 смотрит список агентов",
	};
	const label = labels[args.action];
	return label ? `${label}${target ? ` ${target}` : ""}` : undefined;
}

const NOTICE_LIMIT = 4000;
const NOTICE_KEEP_LINE =
	/^(?:\d+\. \S|Workflow run: |Retention-managed async directory: )/;

/** Completion notice of a pi-subagents run ("subagent-notify" custom message), redacted. */
export function subagentNotice(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as {
		role?: unknown;
		customType?: unknown;
		content?: unknown;
	};
	if (record.role !== "custom" || record.customType !== "subagent-notify")
		return undefined;
	const content =
		typeof record.content === "string"
			? record.content
			: resultText({ content: record.content });
	if (!content.trim()) return undefined;
	const redacted = redactDiagnosticText(content);
	const clipped = clip(redacted, NOTICE_LIMIT);
	if (clipped === redacted) return clipped;
	// Long previews push the run-ID lines past the limit; keep them (with their
	// grouped block headers) so verdicts still pair with the exact run.
	const tail = [...redacted]
		.slice(NOTICE_LIMIT - 1)
		.join("")
		.split("\n")
		.slice(1)
		.filter((line) => NOTICE_KEEP_LINE.test(line))
		// Grouped block headers keep the blank line that opens a block.
		.map((line) => (/^\d+\. /.test(line) ? `\n${line}` : line));
	return tail.length ? `${clipped}\n${tail.join("\n")}` : clipped;
}
