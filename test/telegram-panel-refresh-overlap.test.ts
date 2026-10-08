import { describe, expect, it, vi } from "vitest";
import { TelegramPanelRefreshScheduler } from "../src/telegram-panel-refresh.js";

describe("TelegramPanelRefreshScheduler overlapping deadlines", () => {
	it("keeps a blocked execution tracked when a pending timer fires", async () => {
		vi.useFakeTimers();
		const scheduler = new TelegramPanelRefreshScheduler(() => Date.now());
		let release!: () => void;
		const calls: string[] = [];
		scheduler.schedule(
			9,
			() => new Promise<void>((resolve) => (release = resolve)),
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		scheduler.schedule(9, async () => {
			calls.push("newest");
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls).toEqual(["newest"]);
		scheduler.schedule(
			9,
			async () => {
				calls.push("late-safe");
			},
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual(["newest", "late-safe"]);
		let stopped = false;
		const stopping = scheduler.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release();
		await stopping;
		vi.useRealTimers();
	});
});
