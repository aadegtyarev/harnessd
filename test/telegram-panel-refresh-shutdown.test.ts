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
		await scheduler.stop();
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
		await scheduler.stop();
	});

	it("waits for an in-flight refresh before shutdown resolves", async () => {
		let release!: () => void;
		const scheduler = new TelegramPanelRefreshScheduler();
		let finished = false;
		scheduler.schedule(
			3,
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				finished = true;
			},
			true,
		);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		let stopped = false;
		const stopping = scheduler.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release();
		await stopping;
		expect(finished).toBe(true);
		expect(stopped).toBe(true);
	});
});
