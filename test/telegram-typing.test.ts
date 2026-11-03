import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramTyping } from "../src/telegram-typing.js";

afterEach(() => vi.useRealTimers());

function deferred() {
	let resolve!: (value?: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("Telegram typing ownership", () => {
	it("coalesces same-chat requests for four seconds but keeps other chats independent", async () => {
		vi.useFakeTimers();
		const send = vi.fn(async () => true);
		const typing = new TelegramTyping(send);
		typing.request(1);
		typing.request(1);
		typing.request(2);
		await vi.advanceTimersByTimeAsync(3999);
		typing.request(1);
		expect(send.mock.calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		typing.request(1);
		expect(send.mock.calls).toHaveLength(3);
		typing.stop();
	});

	it("retains raw ownership after deadline and honors a late 429 from receipt", async () => {
		vi.useFakeTimers();
		const work = deferred();
		const send = vi.fn((_id: number, _signal: AbortSignal) => work.promise);
		const typing = new TelegramTyping(send);
		typing.request(1);
		const signal = send.mock.calls[0][1];
		await vi.advanceTimersByTimeAsync(5000);
		expect(signal.aborted).toBe(true);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(1);
		work.reject({ error_code: 429, parameters: { retry_after: 10 } });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(9999);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(2);
		typing.stop();
	});

	it("keeps cooldown across inactivity and rejects malformed cooldown values", async () => {
		vi.useFakeTimers();
		const send = vi
			.fn()
			.mockRejectedValueOnce({
				error_code: 429,
				parameters: { retry_after: 20 },
			})
			.mockRejectedValueOnce({
				error_code: 429,
				parameters: { retry_after: -5 },
			});
		const typing = new TelegramTyping(send);
		typing.request(1);
		await vi.advanceTimersByTimeAsync(4000);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(16000);
		typing.request(1);
		await vi.advanceTimersByTimeAsync(4000);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(3);
		typing.stop();
	});

	it("bounds stuck owners without evicting a pending call", async () => {
		vi.useFakeTimers();
		const send = vi.fn(() => new Promise(() => {}));
		const typing = new TelegramTyping(send);
		for (let i = 0; i < 256; i++) typing.request(i);
		typing.request(256);
		await vi.advanceTimersByTimeAsync(6000);
		typing.request(0);
		typing.request(256);
		expect(send).toHaveBeenCalledTimes(256);
		typing.stop();
	});

	it("stops immediately, aborts owned calls and ignores late settlement", async () => {
		vi.useFakeTimers();
		const work = deferred();
		const send = vi.fn((_id: number, _signal: AbortSignal) => work.promise);
		const typing = new TelegramTyping(send);
		typing.request(1);
		const signal = send.mock.calls[0][1];
		typing.stop();
		expect(signal.aborted).toBe(true);
		work.reject({ error_code: 429, parameters: { retry_after: 10 } });
		await vi.advanceTimersByTimeAsync(30000);
		typing.request(1);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
