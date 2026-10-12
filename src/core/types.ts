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

export interface HarnessEvent {
	readonly sessionId: SessionId;
	readonly kind: "output" | "status" | "error" | "input" | "activity";
	readonly text?: string;
	readonly fatal?: boolean;
	readonly inputEvent?: InputEvent;
	readonly activityEvent?: HarnessActivityEvent;
}
