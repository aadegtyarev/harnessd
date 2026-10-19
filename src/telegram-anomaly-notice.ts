import type {
	HarnessAnomaly,
	HarnessStop,
	HarnessStopReason,
	InputFailure,
	InputFailureReason,
	SessionId,
} from "./core/types.js";

/** At most one chat notice per session and anomaly kind in this window. */
export const ANOMALY_NOTICE_WINDOW_MS = 60_000;

function size(bytes: number | undefined): string | undefined {
	if (bytes === undefined) return undefined;
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

function times(count: number): string {
	const tens = count % 100;
	const ones = count % 10;
	if (tens >= 11 && tens <= 14) return "раз";
	return ones >= 2 && ones <= 4 ? "раза" : "раз";
}

/** How Telegram presents an anomaly: its own notice, journal only, or folded into the stop message. */
export type AnomalyRoute = "notice" | "journal" | "stop";

/**
 * Chats hear only about real problems: a skipped record, a failed command, a harnessd
 * bug, or Pi stopping. Healthy tolerance (an oversized record handled by type, a prompt
 * held during compaction, a record cut while harnessd itself stops Pi) is journal only;
 * failures that already have a chat message (input failures, Pi stopping) are folded
 * into that message instead of duplicated.
 */
export function anomalyRoute(anomaly: HarnessAnomaly): AnomalyRoute {
	switch (anomaly.kind) {
		case "prompt_held":
		case "prompt_rejected":
		case "prompt_hold_timeout":
			return "journal";
		case "corrupted_stream":
			return "stop";
		case "truncated_record":
			return anomaly.stopRequested ? "journal" : "stop";
		case "oversized_record":
			return anomaly.action === "handled" ? "journal" : "notice";
		default:
			return "notice";
	}
}

function facts(anomaly: HarnessAnomaly): string {
	const known = [anomaly.recordType, size(anomaly.bytes)].filter(Boolean);
	return known.length ? ` (${known.join(", ")})` : "";
}

function what(anomaly: HarnessAnomaly): string {
	const about = facts(anomaly);
	const command = anomaly.command ? ` ${anomaly.command}` : "";
	switch (anomaly.kind) {
		case "oversized_record":
			return `Pi прислал запись RPC больше лимита${about}.`;
		case "invalid_json":
			return `Pi прислал строку RPC, которая не является JSON${about}.`;
		case "missing_type":
			return `Pi прислал запись RPC без поля type${about}.`;
		case "response_without_id":
			return `Pi прислал ответ${command} без идентификатора команды.`;
		case "response_mismatch":
			return `Ответ Pi не совпал с ожидаемой командой${command}.`;
		case "malformed_response":
			return `Pi прислал некорректный ответ на команду${command}.`;
		case "handler_error":
			return `Ошибка в harnessd при обработке события Pi${about}; поток Pi в порядке.`;
		case "truncated_record":
			return `Последняя запись RPC оборвалась при остановке Pi${about}.`;
		case "corrupted_stream":
			return "Поток RPC от Pi повреждён: больше 20 некорректных записей подряд.";
		case "prompt_held":
			return "Pi сжимает контекст и пока не принимает сообщения.";
		case "prompt_hold_timeout":
			return "Pi слишком долго сжимал контекст.";
		case "prompt_rejected":
			return `Pi отклонил сообщение${anomaly.detail ? `: ${anomaly.detail}` : ""}.`;
	}
}

function did(anomaly: HarnessAnomaly): string {
	if (anomaly.kind === "handler_error")
		return "harnessd не обработал это событие.";
	switch (anomaly.action) {
		case "skipped":
			return "harnessd пропустил эту запись.";
		case "handled":
			return "harnessd обработал событие по началу записи, остальное отброшено.";
		case "failed_command":
			return `Команда${anomaly.command ? ` ${anomaly.command}` : ""} завершена с ошибкой.`;
		case "held_prompt":
			return "Сообщение отложено и будет отправлено после сжатия.";
		case "failed_input":
			return "Сообщение не доставлено и повторно не отправлялось.";
		case "stopped":
			return "harnessd остановил процесс Pi.";
	}
}

function running(anomaly: HarnessAnomaly): string {
	return anomaly.harnessRunning ? "Pi продолжает работать." : "Pi остановлен.";
}

/** Plain-Russian chat notice: what happened, what harnessd did, and whether Pi keeps running. */
export function anomalyNoticeText(
	anomaly: HarnessAnomaly,
	repeats = 0,
): string {
	return [
		what(anomaly),
		did(anomaly),
		running(anomaly),
		...(repeats > 0
			? [`Повторилось ещё ${repeats} ${times(repeats)} за минуту.`]
			: []),
		`Журнал: harnessd, ref ${anomaly.ref}.`,
	].join("\n");
}

const STOP_REASON_TEXT: Readonly<
	Record<HarnessStopReason, (stop: HarnessStop) => string>
> = {
	process_exited: (stop) => `процесс завершился (${stop.exit ?? "неизвестно"})`,
	stream_corrupted: () => "поток протокола сессии повреждён",
	stdout_not_closed: () => "процесс завершился, но его вывод не закрылся",
	stdout_closed_early: () => "вывод процесса закрылся раньше самого процесса",
	channel_failed: (stop) =>
		stop.channel ? `ошибка канала ${stop.channel}` : "ошибка канала процесса",
	event_stream_failed: () => "поток событий сессии прервался",
};

/**
 * The one chat message for a session's process stopping, in harness-neutral Russian
 * picked by the stop reason code (the English detail is only the fallback), with a
 * folded stop anomaly (a record cut by the stop, or a corrupted stream) and its
 * journal reference.
 */
export function stopNoticeText(
	detail: string,
	stop?: HarnessStop,
	folded?: HarnessAnomaly,
): string {
	const reason = stop ? STOP_REASON_TEXT[stop.reason](stop) : detail;
	return [
		`Сессия остановлена: ${reason}.`,
		...(folded?.kind === "truncated_record"
			? [`Последняя запись RPC оборвалась${facts(folded)} и пропущена.`]
			: []),
		...(folded?.kind === "corrupted_stream"
			? ["Больше 20 некорректных записей RPC подряд."]
			: []),
		...(folded ? [`Журнал: harnessd, ref ${folded.ref}.`] : []),
	].join("\n");
}

const INPUT_FAILURE_TEXT: Readonly<
	Record<InputFailureReason, (failure: InputFailure) => string>
> = {
	prompt_rejected: (failure) =>
		`не принят — Pi отклонил сообщение${failure.text ? `: ${failure.text}` : ""}`,
	hold_timeout: () => "не отправлен — Pi слишком долго сжимал контекст",
	held_and_stopped: () =>
		"не отправлен — Pi остановился, пока сообщение ждало конца сжатия",
	canceled: () => "отменён пользователем",
};

/** Russian wording for a definite input non-delivery, picked by its reason code. */
export function inputFailureText(
	failure: InputFailure | undefined,
): string | undefined {
	return failure ? INPUT_FAILURE_TEXT[failure.reason](failure) : undefined;
}

const INPUT_FAILURE_STATUS: Readonly<
	Record<InputFailureReason, (subject: "сообщение" | "вложение") => string>
> = {
	prompt_rejected: (subject) => `Pi не принял ${subject}`,
	hold_timeout: () => "Не отправлено: Pi долго сжимал контекст",
	held_and_stopped: () => "Не отправлено: Pi остановился",
	canceled: () => "Отменено пользователем",
};

/** Short live run-card status for a definite input non-delivery, by its reason code. */
export function inputFailureStatus(
	failure: InputFailure | undefined,
	subject: "сообщение" | "вложение" = "сообщение",
): string | undefined {
	return failure ? INPUT_FAILURE_STATUS[failure.reason](subject) : undefined;
}

interface KindState {
	lastSentAt: number;
	pending?: { anomaly: HarnessAnomaly; count: number };
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces anomaly notices per session and kind: the first one is sent at once,
 * repeats inside the window are counted and sent as one notice when the window ends.
 */
export class AnomalyNoticeCoalescer {
	private readonly kinds = new Map<string, KindState>();

	constructor(
		private readonly send: (sessionId: SessionId, text: string) => void,
		private readonly now: () => number = Date.now,
		private readonly windowMs = ANOMALY_NOTICE_WINDOW_MS,
	) {}

	push(sessionId: SessionId, anomaly: HarnessAnomaly): void {
		const key = `${sessionId}\u0000${anomaly.kind}`;
		const now = this.now();
		const state = this.kinds.get(key);
		if (!state || (!state.pending && now - state.lastSentAt >= this.windowMs)) {
			this.kinds.set(key, { lastSentAt: now });
			this.send(sessionId, anomalyNoticeText(anomaly));
			return;
		}
		state.pending = { anomaly, count: (state.pending?.count ?? 0) + 1 };
		state.timer ??= setTimeout(
			() => this.flush(sessionId, key),
			Math.max(0, state.lastSentAt + this.windowMs - now),
		);
	}

	forget(sessionId: SessionId): void {
		for (const [key, state] of this.kinds)
			if (key.startsWith(`${sessionId}\u0000`)) {
				if (state.timer) clearTimeout(state.timer);
				this.kinds.delete(key);
			}
	}

	stop(): void {
		for (const state of this.kinds.values())
			if (state.timer) clearTimeout(state.timer);
		this.kinds.clear();
	}

	private flush(sessionId: SessionId, key: string): void {
		const state = this.kinds.get(key);
		if (!state?.pending) return;
		const { anomaly, count } = state.pending;
		state.pending = undefined;
		state.timer = undefined;
		state.lastSentAt = this.now();
		// The latest occurrence is described; the count covers all repeats in the window.
		this.send(sessionId, anomalyNoticeText(anomaly, count));
	}
}
