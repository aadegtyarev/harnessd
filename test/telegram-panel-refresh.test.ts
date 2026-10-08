import { describe, expect, it, vi } from "vitest";
import { TelegramPanelRefreshScheduler } from "../src/telegram-panel-refresh.js";

describe("TelegramPanelRefreshScheduler", () => {
	it("coalesces to newest work and enforces spacing", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		const refresh = vi.fn(async (_value: string) => {});
		scheduler.schedule(1, async () => refresh("first"), true);
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledWith("first");
		scheduler.schedule(1, async () => refresh("old"));
		scheduler.schedule(1, async () => refresh("new"));
		await vi.advanceTimersByTimeAsync(499);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenLastCalledWith("new");
		vi.useRealTimers();
	});

	it("flushes newest queued work immediately after an in-flight refresh", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		let finish!: () => void;
		const inFlight = new Promise<void>((resolve) => (finish = resolve));
		const refresh = vi.fn(async (_value: string) => {});
		scheduler.schedule(3, async () => inFlight);
		await vi.advanceTimersByTimeAsync(0);
		scheduler.schedule(3, async () => refresh("queued"));
		scheduler.schedule(3, async () => refresh("flushed"), true);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith("flushed");
		vi.useRealTimers();
	});

	it("honors the exact minimum-spacing and maximum-wait deadlines", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		const times: number[] = [];
		const base = Date.now();
		scheduler.schedule(
			4,
			async () => {
				times.push(Date.now() - base);
			},
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		scheduler.schedule(4, async () => {
			times.push(Date.now() - base);
		});
		await vi.advanceTimersByTimeAsync(499);
		expect(times).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(times).toEqual([0, 500]);
		for (let time = 0; time < 20; time++) {
			await vi.advanceTimersByTimeAsync(100);
			scheduler.schedule(4, async () => {
				times.push(Date.now() - base);
			});
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(times.at(-1)).toBe(2500);
		vi.useRealTimers();
	});
});
