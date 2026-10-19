import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	HarnessAnomaly,
	HarnessStop,
	InputFailure,
	SessionId,
} from "../src/core/types.js";
import {
	AnomalyNoticeCoalescer,
	anomalyNoticeText,
	anomalyRoute,
	inputFailureStatus,
	inputFailureText,
	stopNoticeText,
} from "../src/telegram-anomaly-notice.js";

afterEach(() => {
	vi.useRealTimers();
});

const base = { harnessRunning: true, ref: "abcd1234" } as const;

describe("anomalyNoticeText", () => {
	it("says what happened, what harnessd did, that Pi keeps running, and the journal ref", () => {
		expect(
			anomalyNoticeText({
				...base,
				kind: "oversized_record",
				action: "handled",
				recordType: "agent_end",
				bytes: 5 * 1024 * 1024,
			}),
		).toBe(
			[
				"Pi прислал запись RPC больше лимита (agent_end, 5,0 МБ).",
				"harnessd обработал событие по началу записи, остальное отброшено.",
				"Pi продолжает работать.",
				"Журнал: harnessd, ref abcd1234.",
			].join("\n"),
		);
	});

	it.each<[HarnessAnomaly, string]>([
		[
			{ ...base, kind: "invalid_json", action: "skipped", bytes: 12 },
			"Pi прислал строку RPC, которая не является JSON (12 Б).\nharnessd пропустил эту запись.",
		],
		[
			{
				...base,
				kind: "response_mismatch",
				action: "failed_command",
				command: "prompt",
			},
			"Ответ Pi не совпал с ожидаемой командой prompt.\nКоманда prompt завершена с ошибкой.",
		],
		[
			{ ...base, kind: "prompt_held", action: "held_prompt" },
			"Pi сжимает контекст и пока не принимает сообщения.\nСообщение отложено и будет отправлено после сжатия.",
		],
		[
			{
				...base,
				kind: "prompt_rejected",
				action: "failed_input",
				detail: "Agent is busy",
			},
			"Pi отклонил сообщение: Agent is busy.\nСообщение не доставлено и повторно не отправлялось.",
		],
		[
			{
				...base,
				kind: "truncated_record",
				action: "skipped",
				harnessRunning: false,
				stopRequested: true,
				recordType: "agent_end",
				bytes: 2048,
			},
			"Последняя запись RPC оборвалась при остановке Pi (agent_end, 2 КБ).\nharnessd пропустил эту запись.\nPi остановлен.",
		],
		[
			{
				...base,
				kind: "handler_error",
				action: "skipped",
				recordType: "turn_start",
			},
			"Ошибка в harnessd при обработке события Pi (turn_start); поток Pi в порядке.\nharnessd не обработал это событие.\nPi продолжает работать.",
		],
	])("presents %o in plain Russian", (anomaly, start) => {
		expect(anomalyNoticeText(anomaly)).toContain(start);
	});

	it("never shows the journal-only head", () => {
		expect(
			anomalyNoticeText({
				...base,
				kind: "invalid_json",
				action: "skipped",
				head: "private head",
			}),
		).not.toContain("private head");
	});
});

describe("anomalyRoute", () => {
	it.each<[Partial<HarnessAnomaly>, string]>([
		[{ kind: "oversized_record", action: "handled" }, "journal"],
		[{ kind: "oversized_record", action: "skipped" }, "notice"],
		[{ kind: "oversized_record", action: "failed_command" }, "notice"],
		[{ kind: "prompt_held", action: "held_prompt" }, "journal"],
		[{ kind: "prompt_rejected", action: "failed_input" }, "journal"],
		[{ kind: "prompt_hold_timeout", action: "failed_input" }, "journal"],
		[{ kind: "invalid_json", action: "skipped" }, "notice"],
		[{ kind: "response_mismatch", action: "failed_command" }, "notice"],
		[{ kind: "handler_error", action: "skipped" }, "notice"],
		[{ kind: "corrupted_stream", action: "stopped" }, "stop"],
		[{ kind: "truncated_record", action: "skipped" }, "stop"],
		// A record cut while harnessd itself stops Pi needs no chat message.
		[
			{ kind: "truncated_record", action: "skipped", stopRequested: true },
			"journal",
		],
	])("routes %o to %s", (fields, route) => {
		expect(anomalyRoute({ ...base, ...fields } as HarnessAnomaly)).toBe(route);
	});
});

describe("stop and input-failure wording", () => {
	it("presents a session stop in harness-neutral Russian with a folded cut record and its journal ref", () => {
		expect(
			stopNoticeText(
				"Pi process exited (SIGKILL)",
				{ reason: "process_exited", exit: "SIGKILL" },
				{
					...base,
					kind: "truncated_record",
					action: "skipped",
					harnessRunning: false,
					recordType: "agent_end",
					bytes: 300,
				},
			),
		).toBe(
			[
				"Сессия остановлена: процесс завершился (SIGKILL).",
				"Последняя запись RPC оборвалась (agent_end, 300 Б) и пропущена.",
				"Журнал: harnessd, ref abcd1234.",
			].join("\n"),
		);
		expect(
			stopNoticeText(
				"Pi RPC stdout is corrupted: more than 20 consecutive invalid records",
				{ reason: "stream_corrupted" },
				{
					...base,
					kind: "corrupted_stream",
					action: "stopped",
					harnessRunning: false,
				},
			),
		).toBe(
			"Сессия остановлена: поток протокола сессии повреждён.\nБольше 20 некорректных записей RPC подряд.\nЖурнал: harnessd, ref abcd1234.",
		);
	});

	it.each<[HarnessStop, string]>([
		[{ reason: "process_exited" }, "процесс завершился (неизвестно)"],
		[{ reason: "process_exited", exit: "1" }, "процесс завершился (1)"],
		[{ reason: "stream_corrupted" }, "поток протокола сессии повреждён"],
		[{ reason: "stdout_not_closed" }, "вывод не закрылся"],
		[{ reason: "stdout_closed_early" }, "вывод процесса закрылся раньше"],
		[{ reason: "channel_failed", channel: "stdin" }, "ошибка канала stdin"],
		[{ reason: "event_stream_failed" }, "поток событий сессии прервался"],
	])(
		"words stop reason %o by code, not by the English detail",
		(stop, text) => {
			const notice = stopNoticeText("any changed English detail", stop);
			expect(notice).toContain(text);
			expect(notice).not.toContain("English");
			expect(notice).not.toMatch(/\bPi\b/);
		},
	);

	it("falls back to the English detail for a stop without a reason, without naming Pi", () => {
		expect(stopNoticeText("Claude protocol error")).toBe(
			"Сессия остановлена: Claude protocol error.",
		);
	});

	it.each<[InputFailure, string, string]>([
		[
			{ reason: "prompt_rejected", text: "Agent is busy" },
			"не принят — Pi отклонил сообщение: Agent is busy",
			"Pi не принял сообщение",
		],
		[
			{ reason: "prompt_rejected" },
			"не принят — Pi отклонил сообщение",
			"Pi не принял сообщение",
		],
		[
			{ reason: "hold_timeout" },
			"не отправлен — Pi слишком долго сжимал контекст",
			"Не отправлено: Pi долго сжимал контекст",
		],
		[
			{ reason: "held_and_stopped" },
			"не отправлен — Pi остановился, пока сообщение ждало конца сжатия",
			"Не отправлено: Pi остановился",
		],
		[{ reason: "canceled" }, "отменён пользователем", "Отменено пользователем"],
	])("words input failure %o by its reason code", (failure, text, status) => {
		expect(inputFailureText(failure)).toBe(text);
		expect(inputFailureStatus(failure)).toBe(status);
	});

	it("has no wording for an input failure without a reason code", () => {
		expect(inputFailureText(undefined)).toBeUndefined();
		expect(inputFailureStatus(undefined)).toBeUndefined();
		expect(inputFailureStatus({ reason: "prompt_rejected" }, "вложение")).toBe(
			"Pi не принял вложение",
		);
	});
});

describe("AnomalyNoticeCoalescer", () => {
	it("sends at most one notice per session and kind per minute with a repeat count", async () => {
		vi.useFakeTimers();
		const sent: [SessionId, string][] = [];
		const coalescer = new AnomalyNoticeCoalescer((sessionId, text) =>
			sent.push([sessionId, text]),
		);
		const one = "one" as SessionId;
		const invalid = {
			...base,
			kind: "invalid_json",
			action: "skipped",
		} as const;
		coalescer.push(one, invalid);
		coalescer.push(one, invalid);
		coalescer.push(one, { ...invalid, ref: "latest01" });
		coalescer.push(one, { ...invalid, kind: "missing_type" });
		coalescer.push("two" as SessionId, invalid);
		expect(sent.map(([id]) => id)).toEqual(["one", "one", "two"]);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(sent).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(4);
		expect(sent[3]?.[1]).toContain("Повторилось ещё 2 раза за минуту.");
		expect(sent[3]?.[1]).toContain("ref latest01");
		// The flushed notice starts a new window.
		coalescer.push(one, invalid);
		expect(sent).toHaveLength(4);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sent[4]?.[1]).toContain("Повторилось ещё 1 раз за минуту.");
		await vi.advanceTimersByTimeAsync(60_000);
		coalescer.push(one, invalid);
		expect(sent).toHaveLength(6);
		expect(sent[5]?.[1]).not.toContain("Повторилось");
		coalescer.stop();
	});

	it("drops pending repeats when a session is forgotten or the transport stops", async () => {
		vi.useFakeTimers();
		const sent: string[] = [];
		const coalescer = new AnomalyNoticeCoalescer((_id, text) =>
			sent.push(text),
		);
		const invalid = {
			...base,
			kind: "invalid_json",
			action: "skipped",
		} as const;
		coalescer.push("a" as SessionId, invalid);
		coalescer.push("a" as SessionId, invalid);
		coalescer.push("b" as SessionId, invalid);
		coalescer.push("b" as SessionId, invalid);
		coalescer.forget("a" as SessionId);
		coalescer.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sent).toHaveLength(2);
	});
});
