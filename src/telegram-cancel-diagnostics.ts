import { randomUUID } from "node:crypto";

export type CancelSource = "slash" | "card" | "keyboard";
export type CancelResultOutcome =
	| "confirmed"
	| "refused"
	| "uncertain"
	| "error";
export type CancelAckChannel =
	| "reply"
	| "callback"
	| "confirmation"
	| "operation";
export type CancelAckOutcome = "confirmed" | "unconfirmed" | "dropped";
export type CancelTrace = {
	readonly ref: string;
	readonly source: CancelSource;
	resultRecorded: boolean;
};
type PhaseEvent =
	| { phase: "observed"; outcome: "adapter_ingress" | "handler" }
	| { phase: "admission"; outcome: "admitted" | "refused" | "handler" }
	| { phase: "dispatch"; outcome: "started" }
	| { phase: "result"; outcome: CancelResultOutcome }
	| { phase: "ack"; outcome: CancelAckOutcome; channel: CancelAckChannel };
const DIAGNOSTIC_INTERVAL_MS = 60_000;

/** Fixed-field, sampled phase telemetry, not a raw-receipt log or durable audit history. */
export class TelegramCancelDiagnostics {
	// At most 66 source/phase/outcome/channel buckets, independent of refs and external IDs.
	private readonly buckets = new Map<
		string,
		{ at: number; suppressed: number }
	>();
	begin(
		source: CancelSource,
		observation: "adapter_ingress" | "handler",
	): CancelTrace {
		const trace = {
			ref: randomUUID().slice(0, 8),
			source,
			resultRecorded: false,
		};
		this.emit(trace, { phase: "observed", outcome: observation });
		return trace;
	}
	admission(
		trace: CancelTrace,
		outcome: "admitted" | "refused" | "handler",
	): void {
		this.emit(trace, { phase: "admission", outcome });
	}
	dispatch(trace: CancelTrace | undefined): void {
		if (trace) this.emit(trace, { phase: "dispatch", outcome: "started" });
	}
	result(trace: CancelTrace | undefined, outcome: CancelResultOutcome): void {
		if (!trace || trace.resultRecorded) return;
		trace.resultRecorded = true;
		this.emit(trace, { phase: "result", outcome });
	}
	ack(
		trace: CancelTrace | undefined,
		channel: CancelAckChannel,
		outcome: CancelAckOutcome,
	): void {
		if (trace) this.emit(trace, { phase: "ack", outcome, channel });
	}
	private emit(trace: CancelTrace, event: PhaseEvent): void {
		const channel = event.phase === "ack" ? event.channel : undefined;
		const key = `${trace.source}:${event.phase}:${event.outcome}:${channel ?? ""}`;
		const previous = this.buckets.get(key);
		if (previous && Date.now() - previous.at < DIAGNOSTIC_INTERVAL_MS) {
			previous.suppressed = Math.min(
				previous.suppressed + 1,
				Number.MAX_SAFE_INTEGER,
			);
			return;
		}
		this.buckets.set(key, { at: Date.now(), suppressed: 0 });
		try {
			console.error(
				`harnessd: telegram_cancel ref=${trace.ref} source=${trace.source} phase=${event.phase} outcome=${event.outcome}${channel ? ` channel=${channel}` : ""} suppressed=${previous?.suppressed ?? 0}`,
			);
		} catch {
			/* Diagnostic sink failure cannot affect cancellation or acknowledgement delivery. */
		}
	}
}

/** Unknown errors stay errors: no parsing raw messages to infer a cancellation outcome. */
export function cancelResultOutcome(code: string): CancelResultOutcome {
	if (
		[
			"UNCERTAIN_INPUT_DELIVERY",
			"PI_CONTROL_FAILED",
			"COMMAND_UNCERTAIN",
		].includes(code)
	)
		return "uncertain";
	if (
		[
			"UNSUPPORTED_CAPABILITY",
			"SESSION_NOT_FOUND",
			"RELOAD_BUSY",
			"RELOAD_ALREADY_RUNNING",
			"RELOAD_SELECTION_CHANGED",
			"INPUT_NOT_DELIVERED",
		].includes(code)
	)
		return "refused";
	return "error";
}
