import { describe, expect, it, vi } from "vitest";
import { TelegramUpdateIngress } from "../src/telegram-update-ingress.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("TelegramUpdateIngress", () => {
	it("admits exactly 100 ordinary handlers including active, retains FIFO, and refuses overflow", async () => {
		const ingress = new TelegramUpdateIngress(vi.fn());
		const gate = deferred();
		const order: number[] = [];
		const overload = vi.fn(async () => {});
		expect(ingress.admit(false, () => gate.promise, overload)).toBe(true);
		for (let i = 0; i < 99; i++)
			expect(
				ingress.admit(
					false,
					async () => {
						order.push(i);
					},
					overload,
				),
			).toBe(true);
		for (let i = 0; i < 1000; i++)
			expect(
				ingress.admit(
					false,
					async () => {
						order.push(-1);
					},
					overload,
				),
			).toBe(false);
		await flush();
		expect(order).toEqual([]);
		expect(overload).toHaveBeenCalledTimes(1);
		gate.resolve();
		await vi.waitFor(() => expect(order).toHaveLength(99));
		expect(order).toEqual(Array.from({ length: 99 }, (_, i) => i));
		await ingress.close();
	});

	it("bounds cancellation too, serializes operations independently of feedback, and rate limits overload", async () => {
		vi.useFakeTimers();
		try {
			const ingress = new TelegramUpdateIngress(vi.fn());
			const operation = deferred();
			const acknowledgement = deferred();
			const calls = vi.fn(async () => {});
			const feedback = vi.fn(() => acknowledgement.promise);
			const overload = vi.fn(async () => {});
			ingress.admit(true, () => operation.promise, overload);
			for (let i = 0; i < 99; i++) ingress.admit(true, calls, overload);
			for (let i = 0; i < 1000; i++) ingress.admit(true, calls, overload);
			await flush();
			expect(calls).not.toHaveBeenCalled();
			expect(overload).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(4999);
			ingress.admit(true, calls, overload);
			await flush();
			expect(overload).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			ingress.admit(true, calls, overload);
			await flush();
			expect(overload).toHaveBeenCalledTimes(2);
			for (let i = 0; i < 1000; i++) ingress.present(feedback);
			await flush();
			expect(feedback).toHaveBeenCalledTimes(8);
			operation.resolve();
			for (let i = 0; i < 1000; i++) await Promise.resolve();
			expect(calls).toHaveBeenCalledTimes(99);
			expect(ingress.admit(true, calls, overload)).toBe(true);
			await flush();
			expect(calls).toHaveBeenCalledTimes(100);
			acknowledgement.resolve();
			await ingress.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds failure diagnostics and isolates a failing diagnostic sink from later work", async () => {
		const sink = vi.fn(() => {
			throw new Error("diagnostic sink unavailable");
		});
		const ingress = new TelegramUpdateIngress(sink);
		const later = vi.fn(async () => {});
		for (let i = 0; i < 20; i++)
			ingress.admit(
				true,
				async () => {
					throw new Error("handler failed");
				},
				later,
			);
		ingress.admit(true, later, later);
		await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1));
		expect(sink).toHaveBeenCalledTimes(1);
		await ingress.close();
	});

	it("observes capacity and shutdown feedback drops without changing ownership or propagating observer failures", async () => {
		const ingress = new TelegramUpdateIngress(vi.fn());
		const held = deferred();
		const work = vi.fn(() => held.promise);
		const dropped = vi.fn(() => {
			throw new Error("broken drop observer");
		});
		for (let i = 0; i < 8; i++) ingress.present(work);
		expect(() => ingress.present(work, dropped)).not.toThrow();
		expect(dropped).toHaveBeenCalledTimes(1);
		await flush();
		expect(work).toHaveBeenCalledTimes(8);
		held.resolve();
		await flush();
		ingress.present(work, dropped);
		await ingress.close();
		expect(dropped).toHaveBeenCalledTimes(2);
		expect(work).toHaveBeenCalledTimes(8);
		expect(() => ingress.present(work, dropped)).not.toThrow();
		expect(dropped).toHaveBeenCalledTimes(3);
	});

	it("invalidates queued handlers and refuses admission and feedback after close", async () => {
		const ingress = new TelegramUpdateIngress(vi.fn());
		const gate = deferred();
		const later = vi.fn(async () => {});
		ingress.admit(false, () => gate.promise, later);
		await flush();
		ingress.admit(false, later, later);
		ingress.admit(true, later, later);
		ingress.present(later);
		const closed = ingress.close();
		expect(ingress.admit(true, later, later)).toBe(false);
		ingress.present(later);
		gate.resolve();
		await closed;
		expect(later).not.toHaveBeenCalled();
	});
});
