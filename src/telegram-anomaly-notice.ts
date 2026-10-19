import type { HarnessAnomaly, SessionId } from "./core/types.js";

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

/** The process-stop detail in Russian: exit code or signal, or harnessd's own shutdown. */
function stopDetail(detail: string | undefined): string {
	if (!detail) return "";
	if (/shut down/i.test(detail)) return ": harnessd завершал сессию";
	const exit = /exited \(([^)]{1,32})\)/.exec(detail)?.[1];
	return exit ? `: процесс завершился (${exit})` : "";
}

function what(anomaly: HarnessAnomaly): string {
	const facts = [anomaly.recordType, size(anomaly.bytes)].filter(Boolean);
	const about = facts.length ? ` (${facts.join(", ")})` : "";
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
			return `Внутренняя ошибка harnessd при обработке события Pi${about}.`;
		case "truncated_record":
			return `Pi остановился, не дописав последнюю запись RPC${about}${stopDetail(anomaly.detail)}.`;
		case "corrupted_stream":
			return "Поток RPC от Pi повреждён: слишком много некорректных записей подряд.";
		case "prompt_held":
			return "Pi сжимает контекст и пока не принимает сообщения.";
		case "prompt_hold_timeout":
			return "Pi слишком долго сжимал контекст.";
		case "prompt_rejected":
			return `Pi отклонил сообщение${anomaly.detail ? `: ${anomaly.detail}` : ""}.`;
	}
}

function did(anomaly: HarnessAnomaly): string {
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

/** Plain-Russian chat notice: what happened, what harnessd did, and whether Pi keeps running. */
export function anomalyNoticeText(
	anomaly: HarnessAnomaly,
	repeats = 0,
): string {
	return [
		what(anomaly),
		did(anomaly),
		anomaly.harnessRunning
			? "Pi продолжает работать."
			: "Pi остановлен; сессия восстанавливается как обычно.",
		...(repeats > 0
			? [`Повторилось ещё ${repeats} ${times(repeats)} за минуту.`]
			: []),
		`Журнал: harnessd, ref ${anomaly.ref}.`,
	].join("\n");
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
