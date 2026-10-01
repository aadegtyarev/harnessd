export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type InputId = Brand<string, "InputId">;
export type AdapterId = Brand<string, "AdapterId">;
export type ProcessId = Brand<string, "ProcessId">;

export interface SessionSummary {
	readonly id: SessionId;
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

export interface HarnessEvent {
	readonly sessionId: SessionId;
	readonly kind: "output" | "status" | "error" | "input";
	readonly text?: string;
	readonly inputEvent?: InputEvent;
}
