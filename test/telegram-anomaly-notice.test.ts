import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAnomaly, SessionId } from "../src/core/types.js";
import {
	AnomalyNoticeCoalescer,
	anomalyNoticeText,
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
				bytes: 2048,
				detail: "Pi process exited (SIGTERM)",
			},
			"Pi остановился, не дописав последнюю запись RPC (2 КБ): процесс завершился (SIGTERM).\nharnessd пропустил эту запись.\nPi остановлен; сессия восстанавливается как обычно.",
		],
		[
			{
				...base,
				kind: "corrupted_stream",
				action: "stopped",
				harnessRunning: false,
			},
			"Поток RPC от Pi повреждён: слишком много некорректных записей подряд.\nharnessd остановил процесс Pi.",
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
