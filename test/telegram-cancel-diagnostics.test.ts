import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CancelAckChannel,
	type CancelAckOutcome,
	type CancelResultOutcome,
	type CancelSource,
	cancelResultOutcome,
	TelegramCancelDiagnostics,
} from "../src/telegram-cancel-diagnostics.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("TelegramCancelDiagnostics", () => {
	it("correlates fixed safe phase fields without claiming raw Telegram receipt", () => {
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		const diagnostics = new TelegramCancelDiagnostics();
		const trace = diagnostics.begin("slash", "adapter_ingress");
		diagnostics.admission(trace, "admitted");
		diagnostics.dispatch(trace);
		diagnostics.result(trace, "confirmed");
		diagnostics.result(trace, "refused");
		diagnostics.ack(trace, "reply", "confirmed");
		expect(trace.ref).toMatch(/^[a-f0-9]{8}$/);
		expect(sink.mock.calls.map((call) => call[0])).toEqual([
			`harnessd: telegram_cancel ref=${trace.ref} source=slash phase=observed outcome=adapter_ingress suppressed=0`,
			`harnessd: telegram_cancel ref=${trace.ref} source=slash phase=admission outcome=admitted suppressed=0`,
			`harnessd: telegram_cancel ref=${trace.ref} source=slash phase=dispatch outcome=started suppressed=0`,
			`harnessd: telegram_cancel ref=${trace.ref} source=slash phase=result outcome=confirmed suppressed=0`,
			`harnessd: telegram_cancel ref=${trace.ref} source=slash phase=ack outcome=confirmed channel=reply suppressed=0`,
		]);
	});

	it("bounds flood state independently of refs and coalesces counts without a timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const sink = vi.spyOn(console, "error").mockImplementation(() => {});
		const diagnostics = new TelegramCancelDiagnostics();
		for (let i = 0; i < 10_000; i++) {
			const trace = diagnostics.begin("slash", "adapter_ingress");
			diagnostics.admission(trace, "admitted");
			diagnostics.dispatch(trace);
			diagnostics.result(trace, "confirmed");
			diagnostics.ack(trace, "reply", "dropped");
		}
		expect(sink).toHaveBeenCalledTimes(5);
		expect(
			(diagnostics as unknown as { buckets: Map<string, unknown> }).buckets
				.size,
		).toBe(5);
		vi.advanceTimersByTime(59_999);
		diagnostics.begin("slash", "adapter_ingress");
		expect(sink).toHaveBeenCalledTimes(5);
		vi.advanceTimersByTime(1);
		const trace = diagnostics.begin("slash", "adapter_ingress");
		diagnostics.dispatch(trace);
		expect(sink.mock.calls.at(-2)?.[0]).toContain(
			"phase=observed outcome=adapter_ingress suppressed=10000",
		);
		expect(sink.mock.calls.at(-1)?.[0]).toContain(
			"phase=dispatch outcome=started suppressed=9999",
		);
		for (const source of ["slash", "card", "keyboard"] as const) {
			for (const observation of ["adapter_ingress", "handler"] as const)
				diagnostics.begin(source, observation);
			const event = diagnostics.begin(source, "handler");
			for (const outcome of ["admitted", "refused", "handler"] as const)
				diagnostics.admission(event, outcome);
			diagnostics.dispatch(event);
			for (const outcome of [
				"confirmed",
				"refused",
				"uncertain",
				"error",
			] as const)
				diagnostics.result(diagnostics.begin(source, "handler"), outcome);
			for (const channel of [
				"reply",
				"callback",
				"confirmation",
				"operation",
			] as const)
				for (const outcome of ["confirmed", "unconfirmed", "dropped"] as const)
					diagnostics.ack(event, channel, outcome);
		}
		expect(
			(diagnostics as unknown as { buckets: Map<string, unknown> }).buckets
				.size,
		).toBe(66);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("isolates sink failure for every phase and outcome", () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("broken log sink with secret content");
		});
		const diagnostics = new TelegramCancelDiagnostics();
		expect(() => {
			for (const source of [
				"slash",
				"card",
				"keyboard",
			] satisfies CancelSource[]) {
				const trace = diagnostics.begin(source, "handler");
				diagnostics.admission(trace, "handler");
				diagnostics.dispatch(trace);
				for (const outcome of [
					"confirmed",
					"refused",
					"uncertain",
					"error",
				] satisfies CancelResultOutcome[])
					diagnostics.result(diagnostics.begin(source, "handler"), outcome);
				for (const channel of [
					"reply",
					"callback",
					"confirmation",
					"operation",
				] satisfies CancelAckChannel[])
					for (const outcome of [
						"confirmed",
						"unconfirmed",
						"dropped",
					] satisfies CancelAckOutcome[])
						diagnostics.ack(trace, channel, outcome);
			}
		}).not.toThrow();
	});

	it.each([
		["UNSUPPORTED_CAPABILITY", "refused"],
		["SESSION_NOT_FOUND", "refused"],
		["RELOAD_BUSY", "refused"],
		["PI_CONTROL_FAILED", "uncertain"],
		["UNCERTAIN_INPUT_DELIVERY", "uncertain"],
		["COMMAND_UNCERTAIN", "uncertain"],
		["OPERATION_FAILED", "error"],
		["https://secret.invalid/?token=private prompt stderr env", "error"],
	])("classifies safe runtime code %s without echoing it", (code, expected) => {
		expect(cancelResultOutcome(code)).toBe(expected);
	});
});
