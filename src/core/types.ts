export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type InputId = Brand<string, "InputId">;
export type AdapterId = Brand<string, "AdapterId">;
export type ProcessId = Brand<string, "ProcessId">;

export interface SessionSummary {
	readonly id: SessionId;
	readonly name?: string;
	readonly harnessId: AdapterId;
	readonly cwd: string;
	readonly nativeSessionId?: string;
	readonly status: SessionStatus;
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

export interface InputEvent {
	readonly inputId: InputId;
	readonly state: InputDeliveryState;
	readonly detail?: string;
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
			readonly failed: boolean;
	  }
	| {
			readonly type: "notification";
			readonly text: string;
			readonly level?: string;
	  };

export interface HarnessEvent {
	readonly sessionId: SessionId;
	readonly kind: "output" | "status" | "error" | "input" | "activity";
	readonly text?: string;
	readonly fatal?: boolean;
	readonly inputEvent?: InputEvent;
	readonly activityEvent?: HarnessActivityEvent;
}
