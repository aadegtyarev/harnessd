import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cardRetryAfterMs,
	TelegramCardCleanup,
	TelegramCardDiagnostics,
	TelegramCardScheduler,
} from "../src/telegram-card-delivery.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const serverError = () => ({ error_code: 502, description: "Bad Gateway" });
const rateLimit = (retry_after: unknown) => ({
	error_code: 429,
	parameters: { retry_after },
});
function policy(error: unknown) {
	const code = (error as { error_code?: number })?.error_code;
	return {
		transient: code === undefined || code === 429 || code >= 500,
		...(code === 429 ? { retryAfterMs: cardRetryAfterMs(error) } : {}),
	};
}
async function flush() {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("TelegramCardScheduler", () => {
	it("retains only newest work during a burst, keeps one raw call, and spaces edits", async () => {
		const held = deferred();
		let latest = "first";
		const seen: string[] = [];
		const api = vi.fn(async () => {
			seen.push(latest);
			if (seen.length === 1) await held.promise;
		});
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			vi.fn(),
			vi.fn(),
		);
		scheduler.schedule();
		await flush();
		const activeTask = scheduler.task;
		for (let i = 0; i < 10_000; i++) {
			latest = `progress-${i}`;
			scheduler.schedule();
			expect(scheduler.task).toBe(activeTask);
		}
		expect(api).toHaveBeenCalledTimes(1);
		latest = "terminal";
		held.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(499);
		expect(api).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(seen).toEqual(["first", "terminal"]);
		expect(vi.getTimerCount()).toBe(0);
		scheduler.stop();
	});

	it.each(["502", "network"])(
		"bounds %s failures to initial plus two retries without event/lifecycle rearming",
		async (failure) => {
			const api = vi.fn(async () => {
				throw failure === "502"
					? serverError()
					: new Error("private network detail");
			});
			const exhausted = vi.fn();
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			for (let i = 0; i < 1000; i++) scheduler.schedule();
			await vi.advanceTimersByTimeAsync(499);
			expect(api).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(api).toHaveBeenCalledTimes(2);
			for (let i = 0; i < 1000; i++) scheduler.schedule();
			await vi.advanceTimersByTimeAsync(999);
			expect(api).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(api).toHaveBeenCalledTimes(3);
			expect(exhausted).toHaveBeenCalledTimes(1);
			for (let i = 0; i < 1000; i++) scheduler.schedule();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(api).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(0);
			scheduler.stop();
		},
	);

	it.each(["resolve", "reject"])(
		"quarantines a deadline through late raw %s before retrying",
		async (settlement) => {
			const held = deferred();
			let signal: AbortSignal | undefined;
			const api = vi.fn(async (abort: AbortSignal) => {
				signal = abort;
				if (api.mock.calls.length === 1) await held.promise;
			});
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				vi.fn(),
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(5000);
			expect(signal?.aborted).toBe(true);
			for (let i = 0; i < 10_000; i++) scheduler.schedule();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(api).toHaveBeenCalledTimes(1);
			if (settlement === "resolve") held.resolve();
			else held.reject(new Error("late raw rejection"));
			await flush();
			expect(api).toHaveBeenCalledTimes(2);
			scheduler.stop();
		},
	);

	it.each([209, 2_147_484])(
		"honors full retry_after=%s across floods and newest lifecycle intent with one wakeup",
		async (seconds) => {
			let intent = "progress";
			const observed: string[] = [];
			const api = vi.fn(async () => {
				observed.push(intent);
				if (observed.length === 1) throw rateLimit(seconds);
			});
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				vi.fn(),
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			for (let i = 0; i < 1000; i++) scheduler.schedule();
			intent = "collapse";
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
			expect(api).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(observed).toEqual(["progress", "collapse"]);
			scheduler.stop();
		},
	);

	it.each(["success", "not-modified"])(
		"resets the transient episode only after confirmed %s",
		async (confirmation) => {
			const errors = [
				serverError(),
				confirmation === "success"
					? undefined
					: { error_code: 400, description: "message is not modified" },
				serverError(),
				serverError(),
				serverError(),
			];
			const api = vi.fn(async () => {
				const error = errors.shift();
				if (error) throw error;
			});
			const exhausted = vi.fn();
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				(error) => ({
					...policy(error),
					confirmed:
						(error as { description?: string })?.description ===
						"message is not modified",
				}),
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(500);
			scheduler.schedule();
			await vi.advanceTimersByTimeAsync(1999);
			expect(api).toHaveBeenCalledTimes(4);
			expect(exhausted).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(api).toHaveBeenCalledTimes(5);
			expect(exhausted).toHaveBeenCalledTimes(1);
			scheduler.stop();
		},
	);

	it("isolates a failing retry diagnostic sink from operation results and budgets", async () => {
		const api = vi.fn(async () => {
			throw serverError();
		});
		const exhausted = vi.fn();
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			exhausted,
			() => {
				throw new Error("broken sink");
			},
		);
		scheduler.schedule();
		await flush();
		await vi.advanceTimersByTimeAsync(1500);
		expect(api).toHaveBeenCalledTimes(3);
		expect(exhausted).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it("does not let a 429 reset the transient failure budget", async () => {
		const errors = [
			serverError(),
			rateLimit(2),
			new Error("network"),
			serverError(),
		];
		const api = vi.fn(async () => {
			throw errors.shift();
		});
		const exhausted = vi.fn();
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			exhausted,
			vi.fn(),
		);
		scheduler.schedule();
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		expect(api).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(api).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(api).toHaveBeenCalledTimes(4);
		expect(exhausted).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it.each([undefined, 0, -1, "2", NaN, Infinity, null, {}])(
		"bounds malformed retry metadata %s",
		async (metadata) => {
			const api = vi.fn(async () => {
				throw rateLimit(metadata);
			});
			const exhausted = vi.fn();
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(1500);
			expect(api).toHaveBeenCalledTimes(3);
			expect(exhausted).toHaveBeenCalledTimes(1);
			scheduler.stop();
		},
	);

	it("does not shorten unrepresentably huge valid rate limits or create hot timers", async () => {
		const api = vi.fn(async () => {
			throw rateLimit(1e308);
		});
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			vi.fn(),
			vi.fn(),
		);
		scheduler.schedule();
		await flush();
		expect(scheduler.retryAt).toBe(Infinity);
		expect(vi.getTimerCount()).toBe(0);
		scheduler.schedule();
		await vi.advanceTimersByTimeAsync(1e8);
		expect(api).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it("shutdown invalidates timers and late settlement continuations", async () => {
		const held = deferred();
		const api = vi.fn(async () => held.promise);
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			vi.fn(),
			vi.fn(),
		);
		scheduler.schedule();
		await flush();
		scheduler.schedule();
		scheduler.stop();
		held.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("TelegramCardCleanup", () => {
	function setup(
		remove = vi.fn(
			async (
				_chat: number,
				_message: number,
				_signal: AbortSignal,
			): Promise<unknown> => {
				throw serverError();
			},
		),
	) {
		const cleanup = new TelegramCardCleanup(
			remove,
			policy,
			() => false,
			vi.fn(),
		);
		return { cleanup, remove };
	}
	it("makes one initial attempt and one later-close attempt, then drops even on failure, with no housekeeping", async () => {
		const { cleanup, remove } = setup();
		cleanup.exhausted(42, 10, 1);
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3_600_000);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		expect(remove.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			[42, 10],
			[42, 10],
		]);
		cleanup.stop();
	});
	it("does not retry an old target merely because another card exhausts", async () => {
		const { cleanup, remove } = setup();
		cleanup.exhausted(42, 10, 1);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		cleanup.exhausted(42, 11, 2);
		await flush();
		expect(remove.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			[42, 10],
			[42, 11],
		]);
		await vi.advanceTimersByTimeAsync(5000);
		cleanup.onClosure();
		await flush();
		expect(remove.mock.calls[2]?.slice(0, 2)).toEqual([42, 10]);
		cleanup.stop();
	});

	it("skips ineligible closures and preserves full cooldown even when a second failed intent is dropped", async () => {
		const remove = vi.fn(
			async (_chat: number, _message: number, _signal: AbortSignal) => {
				throw rateLimit(209);
			},
		);
		const { cleanup } = setup(remove);
		cleanup.exhausted(42, 10, 1);
		await flush();
		cleanup.exhausted(42, 11, 2);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(208_999);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(remove).toHaveBeenCalledTimes(1);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5000);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(204_000);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(3);
		expect(remove.mock.calls[2]?.slice(0, 2)).toEqual([42, 11]);
		cleanup.stop();
	});
	it("quarantines uncertain deletion through raw settlement, with no replay just because it settles", async () => {
		const held = deferred();
		const remove = vi.fn(
			async (_chat: number, _message: number, _signal: AbortSignal) =>
				held.promise,
		);
		const { cleanup } = setup(remove);
		cleanup.exhausted(42, 10, 1);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5000);
		cleanup.onClosure();
		held.resolve();
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		cleanup.stop();
	});
	it("retires a definitely missing deletion target without retry and invalidates late cleanup after shutdown", async () => {
		const missing = vi.fn(async () => {
			throw { error_code: 400, description: "message to delete not found" };
		});
		const gone = new TelegramCardCleanup(missing, policy, () => true, vi.fn());
		gone.exhausted(42, 10, 1);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		gone.onClosure();
		await flush();
		expect(missing).toHaveBeenCalledTimes(1);
		gone.stop();
		const held = deferred();
		const remove = vi.fn(async () => held.promise);
		const cleanup = new TelegramCardCleanup(
			remove,
			policy,
			() => false,
			vi.fn(),
		);
		cleanup.exhausted(42, 11, 2);
		await flush();
		cleanup.stop();
		await flush();
		expect(vi.getTimerCount()).toBe(0);
		held.resolve();
		await flush();
		cleanup.onClosure();
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("bounds retained intents and per-close work and clears all pending ownership on stop", async () => {
		const { cleanup, remove } = setup();
		for (let i = 0; i < 1000; i++) cleanup.exhausted(42, i, i);
		await flush();
		expect(remove).toHaveBeenCalledTimes(1);
		expect(
			(cleanup as unknown as { intents: Map<string, unknown> }).intents.size,
		).toBe(128);
		await vi.advanceTimersByTimeAsync(5000);
		for (let i = 0; i < 1000; i++) cleanup.onClosure();
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
		cleanup.stop();
		expect(
			(cleanup as unknown as { intents: Map<string, unknown> }).intents.size,
		).toBe(0);
		await vi.advanceTimersByTimeAsync(3_600_000);
		cleanup.onClosure();
		expect(remove).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});

it("coalesces safe fixed-field diagnostics and isolates a broken log sink", () => {
	const sink = vi.spyOn(console, "error").mockImplementation(() => {});
	const diagnostic = new TelegramCardDiagnostics();
	for (let i = 0; i < 1000; i++) diagnostic.report("edit_deferred");
	expect(sink).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(60_000);
	diagnostic.report("edit_deferred");
	expect(sink.mock.calls[1]?.[0]).toBe(
		"harnessd: telegram_card edit_deferred suppressed=999",
	);
	sink.mockImplementation(() => {
		throw new Error("sink failed");
	});
	expect(() => diagnostic.report("edit_exhausted")).not.toThrow();
});

describe("late raw card rate-limit outcomes", () => {
	it.each([209, 2_147_484, Number.MAX_SAFE_INTEGER / 1000, 1e308])(
		"honors retry_after=%s from raw receipt after an edit deadline",
		async (seconds) => {
			const held = deferred();
			const api = vi.fn(async () => {
				if (api.mock.calls.length === 1) await held.promise;
			});
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				vi.fn(),
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(5000);
			for (let i = 0; i < 1000; i++) scheduler.schedule();
			await vi.advanceTimersByTimeAsync(1000);
			held.reject(rateLimit(seconds));
			await flush();
			const retryAt =
				6000 + seconds * 1000 > Number.MAX_SAFE_INTEGER
					? Infinity
					: Math.ceil(6000 + seconds * 1000);
			expect(scheduler.retryAt).toBe(retryAt);
			expect(api).toHaveBeenCalledTimes(1);
			if (retryAt === Infinity) {
				expect(vi.getTimerCount()).toBe(0);
				await vi.advanceTimersByTimeAsync(1e8);
				scheduler.schedule();
				await flush();
				expect(api).toHaveBeenCalledTimes(1);
			} else {
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
				expect(api).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(api).toHaveBeenCalledTimes(2);
			}
			scheduler.stop();
		},
	);

	it.each([undefined, 0, -1, "2", NaN, Infinity, null, {}])(
		"does not replenish or double-charge edit budgets for late malformed retry_after=%s",
		async (metadata) => {
			const held = deferred();
			const api = vi.fn(async () => {
				if (api.mock.calls.length === 1) await held.promise;
				else throw serverError();
			});
			const exhausted = vi.fn();
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(6000);
			held.reject(rateLimit(metadata));
			await flush();
			expect(api).toHaveBeenCalledTimes(2);
			expect(exhausted).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(999);
			expect(api).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(api).toHaveBeenCalledTimes(3);
			expect(exhausted).toHaveBeenCalledTimes(1);
			scheduler.stop();
		},
	);

	it.each(["success", "generic-failure", "rate-limit"])(
		"preserves deadline retry charges after late %s",
		async (outcome) => {
			const held = deferred();
			const api = vi.fn(async () => {
				if (api.mock.calls.length === 1) await held.promise;
				else throw serverError();
			});
			const exhausted = vi.fn();
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(6000);
			if (outcome === "success") held.resolve();
			else
				held.reject(
					outcome === "rate-limit"
						? rateLimit(209)
						: new Error("late network failure"),
				);
			await flush();
			if (outcome === "rate-limit") {
				expect(api).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(209_000);
			}
			expect(api).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1000);
			expect(api).toHaveBeenCalledTimes(3);
			expect(exhausted).toHaveBeenCalledTimes(1);
			scheduler.stop();
		},
	);

	it.each([209, 2_147_484, Number.MAX_SAFE_INTEGER / 1000, 1e308])(
		"hands exhausted edit cooldown retry_after=%s to exact-target closure-only cleanup",
		async (seconds) => {
			const held = deferred();
			const api = vi.fn(async () => {
				if (api.mock.calls.length === 3) await held.promise;
				else throw serverError();
			});
			const remove = vi.fn(async () => true);
			const cleanup = new TelegramCardCleanup(
				remove,
				policy,
				() => false,
				vi.fn(),
			);
			const exhausted = vi.fn((notBefore: number) =>
				cleanup.exhausted(42, 10, 1, notBefore),
			);
			const scheduler = new TelegramCardScheduler(
				async () => {
					await scheduler.edit(api);
				},
				policy,
				exhausted,
				vi.fn(),
			);
			scheduler.schedule();
			await flush();
			await vi.advanceTimersByTimeAsync(6500);
			expect(api).toHaveBeenCalledTimes(3);
			expect(exhausted).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1000);
			held.reject(rateLimit(seconds));
			await flush();
			const eligibleAt =
				7500 + seconds * 1000 > Number.MAX_SAFE_INTEGER
					? Infinity
					: Math.ceil(7500 + seconds * 1000);
			expect(exhausted).toHaveBeenCalledExactlyOnceWith(eligibleAt);
			cleanup.onClosure();
			await flush();
			expect(remove).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			if (eligibleAt === Infinity) {
				await vi.advanceTimersByTimeAsync(1e8);
				cleanup.onClosure();
				await flush();
				expect(remove).not.toHaveBeenCalled();
			} else {
				await vi.advanceTimersByTimeAsync(eligibleAt - Date.now() - 1);
				cleanup.onClosure();
				await flush();
				expect(remove).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(remove).not.toHaveBeenCalled();
				cleanup.onClosure();
				await flush();
				expect(remove).toHaveBeenCalledExactlyOnceWith(
					42,
					10,
					expect.any(AbortSignal),
				);
			}
			scheduler.stop();
			cleanup.stop();
		},
	);

	it.each([
		[1, 209],
		[2, 209],
		[1, 2_147_484],
		[2, 2_147_484],
		[1, Number.MAX_SAFE_INTEGER / 1000],
		[2, Number.MAX_SAFE_INTEGER / 1000],
		[1, 1e308],
		[2, 1e308],
	])(
		"preserves late 429 from cleanup attempt %s with retry_after=%s, even if its target was dropped",
		async (attempt, seconds) => {
			const held = deferred();
			const remove = vi.fn(
				async (_chat: number, _message: number, _signal: AbortSignal) => {
					if (remove.mock.calls.length === attempt) await held.promise;
					else throw serverError();
				},
			);
			const cleanup = new TelegramCardCleanup(
				remove,
				policy,
				() => false,
				vi.fn(),
			);
			cleanup.exhausted(42, 10, 1);
			await flush();
			if (attempt === 2) {
				await vi.advanceTimersByTimeAsync(5000);
				cleanup.onClosure();
				await flush();
			}
			const startedAt = Date.now();
			await vi.advanceTimersByTimeAsync(6000);
			cleanup.exhausted(42, 11, 2); // retained while the raw call still owns cleanup
			held.reject(rateLimit(seconds));
			await flush();
			const eligibleAt =
				startedAt + 6000 + seconds * 1000 > Number.MAX_SAFE_INTEGER
					? Infinity
					: Math.ceil(startedAt + 6000 + seconds * 1000);
			for (let i = 0; i < 1000; i++) cleanup.onClosure();
			await flush();
			expect(remove).toHaveBeenCalledTimes(attempt);
			if (eligibleAt === Infinity) {
				await vi.advanceTimersByTimeAsync(1e8);
				cleanup.onClosure();
				await flush();
				expect(remove).toHaveBeenCalledTimes(attempt);
				expect(vi.getTimerCount()).toBe(0);
			} else {
				await vi.advanceTimersByTimeAsync(eligibleAt - Date.now() - 1);
				cleanup.onClosure();
				await flush();
				expect(remove).toHaveBeenCalledTimes(attempt);
				await vi.advanceTimersByTimeAsync(1);
				expect(remove).toHaveBeenCalledTimes(attempt);
				expect(vi.getTimerCount()).toBe(0);
				cleanup.onClosure();
				await flush();
				expect(remove).toHaveBeenCalledTimes(attempt + 1);
				expect(remove.mock.calls.at(-1)?.slice(0, 2)).toEqual([
					42,
					attempt === 1 ? 10 : 11,
				]);
			}
			cleanup.stop();
		},
	);

	it.each([
		[1, "success"],
		[2, "success"],
		[1, "generic-failure"],
		[2, "generic-failure"],
		[1, "invalid-rate-limit"],
		[2, "invalid-rate-limit"],
	] as const)(
		"does not auto-replay or add cooldown for cleanup attempt %s late %s",
		async (attempt, outcome) => {
			const held = deferred();
			const remove = vi.fn(
				async (_chat: number, _message: number, _signal: AbortSignal) => {
					if (remove.mock.calls.length === attempt) await held.promise;
					else throw serverError();
				},
			);
			const cleanup = new TelegramCardCleanup(
				remove,
				policy,
				() => false,
				vi.fn(),
			);
			cleanup.exhausted(42, 10, 1);
			await flush();
			if (attempt === 2) {
				await vi.advanceTimersByTimeAsync(5000);
				cleanup.onClosure();
				await flush();
			}
			await vi.advanceTimersByTimeAsync(6000);
			if (attempt === 2) cleanup.exhausted(42, 11, 2);
			if (outcome === "success") held.resolve();
			else
				held.reject(
					outcome === "invalid-rate-limit" ? rateLimit(NaN) : serverError(),
				);
			await flush();
			expect(remove).toHaveBeenCalledTimes(attempt);
			expect(vi.getTimerCount()).toBe(0);
			if (attempt === 1) {
				cleanup.onClosure();
				await flush();
				expect(remove).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(4000);
				expect(remove).toHaveBeenCalledTimes(1);
			}
			cleanup.onClosure();
			await flush();
			expect(remove).toHaveBeenCalledTimes(attempt + 1);
			expect(remove.mock.calls.at(-1)?.slice(0, 2)).toEqual([
				42,
				attempt === 1 ? 10 : 11,
			]);
			expect(
				(cleanup as unknown as { intents: Map<string, unknown> }).intents.has(
					JSON.stringify([42, 10]),
				),
			).toBe(false);
			cleanup.stop();
		},
	);

	it("suppresses late 429 state updates and continuations after shutdown", async () => {
		const editHeld = deferred();
		const api = vi.fn(async () => editHeld.promise);
		const exhausted = vi.fn();
		const scheduler = new TelegramCardScheduler(
			async () => {
				await scheduler.edit(api);
			},
			policy,
			exhausted,
			vi.fn(),
		);
		const cleanupHeld = deferred();
		const remove = vi.fn(async () => cleanupHeld.promise);
		const cleanup = new TelegramCardCleanup(
			remove,
			policy,
			() => false,
			vi.fn(),
		);
		scheduler.schedule();
		cleanup.exhausted(42, 10, 1);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		const retryAt = scheduler.retryAt;
		scheduler.stop();
		cleanup.stop();
		await vi.advanceTimersByTimeAsync(1000);
		editHeld.reject(rateLimit(209));
		cleanupHeld.reject(rateLimit(209));
		await flush();
		expect(scheduler.retryAt).toBe(retryAt);
		expect(exhausted).not.toHaveBeenCalled();
		scheduler.schedule();
		cleanup.onClosure();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(api).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(
			(cleanup as unknown as { intents: Map<string, unknown> }).intents.size,
		).toBe(0);
	});
});
