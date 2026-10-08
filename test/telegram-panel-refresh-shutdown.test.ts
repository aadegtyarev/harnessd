import { describe, expect, it, vi } from "vitest";
import { TelegramPanelRefreshScheduler } from "../src/telegram-panel-refresh.js";

describe("TelegramPanelRefreshScheduler shutdown", () => {
	it("cancels pending work and reports rejected refreshes", async () => {
		vi.useFakeTimers();
		const errors: unknown[] = [];
		const scheduler = new TelegramPanelRefreshScheduler(
			() => Date.now(),
			500,
			2000,
			(error) => errors.push(error),
		);
		const refresh = vi.fn(async () => {});
		scheduler.schedule(1, refresh);
		scheduler.stop();
		await vi.advanceTimersByTimeAsync(2500);
		expect(refresh).not.toHaveBeenCalled();
		scheduler.schedule(
			1,
			async () => {
				throw new Error("refresh failed");
			},
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(errors).toHaveLength(0);
		vi.useRealTimers();
	});

	it("reports in-flight refresh rejection", async () => {
		const errors: unknown[] = [];
		const scheduler = new TelegramPanelRefreshScheduler(
			Date.now,
			500,
			2000,
			(error) => errors.push(error),
		);
		scheduler.schedule(
			2,
			async () => {
				throw new Error("refresh failed");
			},
			true,
		);
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		scheduler.stop();
	});
});
