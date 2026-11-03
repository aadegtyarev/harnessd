import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramApiMetrics } from "../src/telegram-api-metrics.js";

afterEach(() => vi.useRealTimers());

describe("Telegram API aggregate metrics", () => {
	it("observes real grammY API calls with a synthetic transport", async () => {
		vi.useFakeTimers();
		const sink = vi.fn();
		const metrics = new TelegramApiMetrics(sink);
		const api = new Api("test-token");
		api.config.use(
			async () =>
				({
					ok: true,
					result: { id: 42, is_bot: true, first_name: "Test" },
				}) as never,
		);
		api.config.use(metrics.transformer);
		await expect(api.getMe()).resolves.toMatchObject({ is_bot: true });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink.mock.calls[0][0]).toContain('"getMe":{"started":1,"ok":1');
		metrics.stop();
	});

	it("counts concurrent synthetic lanes, results and retries without exposing payloads", async () => {
		vi.useFakeTimers();
		const sink = vi.fn();
		const metrics = new TelegramApiMetrics(sink);
		let finish!: (result: unknown) => void;
		const pending = new Promise((resolve) => {
			finish = resolve;
		});
		const prev = vi.fn((_method: unknown) => pending);
		const payload = { chat_id: 12345678, text: "private-secret-text" };
		const card = metrics.transformer(
			prev as never,
			"editMessageText",
			payload as never,
		);
		const typing = metrics.transformer(
			prev as never,
			"sendChatAction",
			payload as never,
		);
		const output = metrics.transformer(
			prev as never,
			"sendMessage",
			payload as never,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink).toHaveBeenCalledTimes(1);
		const line = sink.mock.calls[0][0] as string;
		expect(line).not.toContain("private-secret-text");
		expect(line).not.toContain("12345678");
		const first = JSON.parse(line.split("telegram_api_metrics ")[1]);
		expect(first.peak_in_flight).toBe(3);
		expect(first.peak_starts_per_second).toBe(3);
		expect(first.methods.sendMessage.started).toBe(1);
		expect(first.methods.editMessageText.started).toBe(1);
		finish({ ok: false, error_code: 429, description: "private-secret-text" });
		await Promise.all([card, typing, output]);
		await metrics.transformer(
			(async () => ({ ok: true, result: true })) as never,
			"sendMessage",
			payload as never,
		);
		const error = new Error("private-secret-text");
		await expect(
			metrics.transformer(
				(async () => {
					throw error;
				}) as never,
				"getMe",
				{} as never,
			),
		).rejects.toBe(error);
		await vi.advanceTimersByTimeAsync(60_000);
		const secondLine = sink.mock.calls[1][0] as string;
		expect(secondLine).not.toContain("private-secret-text");
		const second = JSON.parse(secondLine.split("telegram_api_metrics ")[1]);
		expect(second.methods.sendMessage).toMatchObject({
			started: 1,
			ok: 1,
			rateLimited: 1,
		});
		expect(second.methods.getMe.failed).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink).toHaveBeenCalledTimes(2);
		metrics.stop();
	});

	it("pauses periodic reporting while preserving shutdown accounting", async () => {
		vi.useFakeTimers();
		const sink = vi.fn();
		const metrics = new TelegramApiMetrics(sink);
		await vi.advanceTimersByTimeAsync(59_000);
		metrics.pause();
		await metrics.transformer(
			(async () => ({ ok: true, result: true })) as never,
			"getUpdates",
			{} as never,
		);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(sink).not.toHaveBeenCalled();
		metrics.stop();
		expect(sink).toHaveBeenCalledOnce();
		expect(sink.mock.calls[0][0]).toContain('"getUpdates":{"started":1,"ok":1');
	});

	it("does not emit after bounded shutdown when a raw call settles late", async () => {
		vi.useFakeTimers();
		const sink = vi.fn();
		const metrics = new TelegramApiMetrics(sink);
		let finish!: (value: unknown) => void;
		const raw = new Promise((resolve) => {
			finish = resolve;
		});
		const call = metrics.transformer(
			(() => raw) as never,
			"sendMessage",
			{} as never,
		);
		metrics.stop();
		finish({ ok: false, error_code: 429 });
		await call;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink).toHaveBeenCalledTimes(1);
		const line = sink.mock.calls[0][0] as string;
		expect(line).toContain('"started":1');
		expect(line).toContain('"rateLimited":0');
	});

	it("flushes a partial startup window once on shutdown", async () => {
		vi.useFakeTimers();
		const sink = vi.fn();
		const metrics = new TelegramApiMetrics(sink);
		await metrics.transformer(
			(async () => ({ ok: true, result: true })) as never,
			"getMe",
			{} as never,
		);
		metrics.stop();
		metrics.stop();
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0][0]).toContain('"getMe":{"started":1,"ok":1');
	});

	it("passes through results and errors even if logging fails, and stops diagnostics", async () => {
		vi.useFakeTimers();
		const sink = vi.fn(() => {
			throw new Error("sink unavailable");
		});
		const metrics = new TelegramApiMetrics(sink);
		const response = { ok: false, error_code: 400, description: "secret" };
		await expect(
			metrics.transformer(
				(async () => response) as never,
				"getUpdates",
				{} as never,
			),
		).resolves.toBe(response);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink).toHaveBeenCalledTimes(1);
		metrics.stop();
		await metrics.transformer(
			(async () => response) as never,
			"getUpdates",
			{} as never,
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sink).toHaveBeenCalledTimes(1);
	});
});
