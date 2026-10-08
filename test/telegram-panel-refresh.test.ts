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

	it("flushes immediately and bounds continuous bursts by max wait", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		const refresh = vi.fn(async (_value: string) => {});
		scheduler.schedule(2, async () => refresh("first"), true);
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 6; index++) {
			await vi.advanceTimersByTimeAsync(300);
			scheduler.schedule(2, async () => refresh(`burst-${index}`));
		}
		await vi.advanceTimersByTimeAsync(200);
		expect(refresh).toHaveBeenLastCalledWith("burst-5");
		scheduler.schedule(2, async () => refresh("terminal"), true);
		await vi.waitFor(() =>
			expect(refresh).toHaveBeenLastCalledWith("terminal"),
		);
		vi.useRealTimers();
	});
});
