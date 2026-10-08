import { describe, expect, it, vi } from "vitest";
import { TelegramPanelRefreshScheduler } from "../src/telegram-panel-refresh.js";

describe("TelegramPanelRefreshScheduler backlog timing", () => {
	it("bounds a sustained API-edit backlog to two seconds and terminal flushes at the boundary", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		const began = Date.now();
		const apiEdit = vi.fn(async (_text: string) => {});
		const publish = (text: string) => async () => apiEdit(text);
		let finishFirst!: () => void;
		scheduler.schedule(
			8,
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 20; index++) {
			await vi.advanceTimersByTimeAsync(100);
			scheduler.schedule(8, publish(`backlog-${index}`));
		}
		finishFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(apiEdit).toHaveBeenLastCalledWith("backlog-19");
		expect(Date.now() - began).toBe(2000);
		scheduler.schedule(8, publish("explicit-terminal"), true);
		await vi.advanceTimersByTimeAsync(0);
		expect(apiEdit).toHaveBeenLastCalledWith("explicit-terminal");
		expect(Date.now() - began).toBe(2000);
		await scheduler.stop();
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
