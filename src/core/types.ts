export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type InputId = Brand<string, "InputId">;
export type AdapterId = Brand<string, "AdapterId">;
export type ProcessId = Brand<string, "ProcessId">;

export type AdapterOptionValue =
	| string
	| number
	| boolean
	| null
	| readonly AdapterOptionValue[]
	| { readonly [key: string]: AdapterOptionValue };
export type AdapterOptions = Readonly<Record<string, AdapterOptionValue>>;

export interface SessionSummary {
	readonly id: SessionId;
	readonly name?: string;
	readonly harnessId: AdapterId;
	readonly cwd: string;
	readonly nativeSessionId?: string;
	readonly adapterOptions?: AdapterOptions;
	readonly status: SessionStatus;
	/** Fixed cause of the last transition to `failed`; cleared when the session runs again. */
	readonly failureReason?: SessionFailureReason;
	/** ISO-8601 time of the last transition to `failed`; cleared with `failureReason`. */
	readonly failedAt?: string;
}

export type SessionFailureReason =
	| "launch_failed"
	| "unexpected_exit"
	| "resume_unavailable"
	| "native_id_mismatch"
	| "options_replacement_failed";

export interface SessionFailure {
	readonly reason: SessionFailureReason;
	readonly at: string;
}

export type SessionStatus =
	| "starting"
	| "running"
	| "stopped"
	| "failed"
	| "uncertain";

export interface Input {
	readonly id: InputId;
	readonly sessionId: SessionId;
	readonly text: string;
	readonly images?: readonly {
		readonly mimeType: string;
		readonly data: string;
	}[];
	readonly createdAt: Date;
}

export type InputDeliveryState =
	| "pending"
	| "accepted"
	| "completed"
	| "uncertain"
	| "failed";

/** Fixed reason a harness reports for a definite input non-delivery. */
export type InputFailureReason =
	/** The harness process explicitly rejected the input. */
	| "prompt_rejected"
	/** The input was held (for example during compaction) and the hold timed out unsent. */
	| "hold_timeout"
	/** The harness process stopped while the input was held unsent. */
	| "held_and_stopped"
	/** The operator canceled the input. */
	| "canceled";

/** Structured cause of a definite input non-delivery, for presentation by code. */
export interface InputFailure {
	readonly reason: InputFailureReason;
	/** Harness-supplied, redacted and bounded reason text (for example Pi's own rejection message). */
	readonly text?: string;
}

export interface InputEvent {
	readonly inputId: InputId;
	readonly state: InputDeliveryState;
	/** English safe detail for journals and fallback presentation. */
	readonly detail?: string;
	/** Structured cause of a `failed` state when the harness knows it. */
	readonly failure?: InputFailure;
}

/** Fixed reason a harness process stopped unexpectedly (a fatal session error). */
export type HarnessStopReason =
	| "process_exited"
	| "stream_corrupted"
	| "stdout_not_closed"
	| "stdout_closed_early"
	| "channel_failed"
	| "event_stream_failed";

/** Structured cause of a fatal session error, for presentation by code. */
export interface HarnessStop {
	readonly reason: HarnessStopReason;
	/** Exit code or signal for `process_exited`, when known. */
	readonly exit?: string;
	/** Failed stdio channel for `channel_failed`. */
	readonly channel?: "stdin" | "stdout" | "stderr";
}

export type HarnessActivityEvent =
	| { readonly type: "thinking"; readonly active: boolean }
	| {
			readonly type: "tool_start";
			readonly toolCallId: string;
			readonly summary: string;
	  }
	| {
			readonly type: "tool_end";
			readonly toolCallId: string;
			/** Absent when the harness could not read the outcome. */
			readonly failed?: boolean;
			/** Short outcome such as a bash exit code. */
			readonly detail?: string;
	  }
	| {
			/** One-line reasoning summary (a title, never full reasoning). */
			readonly type: "thought";
			readonly text: string;
	  }
	| {
			/** Bounded-task state published by the harness (for example Pi /task). */
			readonly type: "task";
			readonly goal: string;
			readonly progress?: string;
			readonly status: string;
			readonly step: number;
			readonly limit?: number;
	  }
	| {
			/** A subagent completion notice delivered to the parent session. */
			readonly type: "agent_notice";
			readonly text: string;
	  }
	| {
			readonly type: "notification";
			readonly text: string;
			readonly level?: string;
			/** Widget key for widget updates; an empty text then means the widget was cleared. */
			readonly widgetKey?: string;
	  };

/** Fixed kinds of harness protocol/delivery anomalies that harnessd tolerated or acted on. */
export type HarnessAnomalyKind =
	| "oversized_record"
	| "invalid_json"
	| "missing_type"
	| "response_without_id"
	| "response_mismatch"
	| "malformed_response"
	| "handler_error"
	| "truncated_record"
	| "corrupted_stream"
	| "prompt_held"
	| "prompt_hold_timeout"
	| "prompt_rejected";

/** What harnessd did about an anomaly. */
export type HarnessAnomalyAction =
	| "skipped"
	| "handled"
	| "failed_command"
	| "held_prompt"
	| "failed_input"
	| "stopped";

/**
 * A safe, typed anomaly report. Text fields are already redacted and bounded by the
 * harness; `head` is journal-only diagnostic context and is never shown in chats.
 */
export interface HarnessAnomaly {
	readonly kind: HarnessAnomalyKind;
	readonly action: HarnessAnomalyAction;
	/** Whether the harness process keeps running after this anomaly. */
	readonly harnessRunning: boolean;
	/** The harness was being stopped by harnessd itself (not an unexpected exit). */
	readonly stopRequested?: boolean;
	/** Short correlation reference shared by the journal line and chat notice. */
	readonly ref: string;
	/** Record type when known (a short safe token). */
	readonly recordType?: string;
	/** Correlated command name when known (a short safe token). */
	readonly command?: string;
	/** Byte length of the offending record when known. */
	readonly bytes?: number;
	/** Redacted, bounded head of a non-oversized record (journal only). */
	readonly head?: string;
	/** Redacted, bounded detail such as Pi's own error text or the exit state. */
	readonly detail?: string;
}

export interface HarnessEvent {
	readonly sessionId: SessionId;
	readonly kind:
		| "output"
		| "status"
		| "error"
		| "input"
		| "activity"
		| "anomaly";
	readonly text?: string;
	readonly fatal?: boolean;
	/** Structured cause of a fatal error when the harness knows it; `text` stays the English fallback. */
	readonly stop?: HarnessStop;
	readonly inputEvent?: InputEvent;
	readonly activityEvent?: HarnessActivityEvent;
	readonly anomalyEvent?: HarnessAnomaly;
}
