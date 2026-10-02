import type { Readable, Writable } from "node:stream";
import type { Capability } from "./errors.js";
import type {
	AdapterId,
	HarnessEvent,
	Input,
	InputEvent,
	InputId,
	ProcessId,
	SessionId,
	SessionSummary,
} from "./types.js";

export interface PortDescriptor {
	readonly id: AdapterId;
	readonly capabilities: readonly Capability[];
}

export interface SessionPort {
	readonly descriptor: PortDescriptor;
	list(): Promise<readonly SessionSummary[]>;
	get(id: SessionId): Promise<SessionSummary | undefined>;
	create(input: {
		readonly harnessId: AdapterId;
		readonly cwd: string;
	}): Promise<SessionSummary>;
	stop(id: SessionId): Promise<void>;
}

export interface InputPort {
	readonly descriptor: PortDescriptor;
	submit(input: Input): Promise<void>;
	cancel(sessionId: SessionId, inputId: InputId): Promise<void>;
}

export type TransportEvent =
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "list";
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "inspect";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "create";
			readonly harnessId: AdapterId;
			readonly cwd: string;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "stop";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "submit";
			readonly sessionId: SessionId;
			readonly text: string;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "cancel";
			readonly sessionId: SessionId;
			readonly inputId: InputId;
	  };

export type TransportResult =
	| {
			readonly requestId: string;
			readonly ok: true;
			readonly value:
				| readonly SessionSummary[]
				| SessionSummary
				| InputId
				| undefined;
	  }
	| {
			readonly requestId: string;
			readonly ok: false;
			readonly error: {
				readonly code: string;
				readonly message: string;
				readonly inputId?: InputId;
			};
	  };

export type TransportEventListener = (event: HarnessEvent) => unknown;
export type TransportEventSubscription = (
	listener: TransportEventListener,
) => () => void;

export interface TransportAdapter {
	readonly descriptor: PortDescriptor;
	start(
		dispatch: (event: TransportEvent) => Promise<TransportResult>,
		subscribeEvents: TransportEventSubscription,
	): Promise<void>;
	stop(): Promise<void>;
}

export interface HarnessLaunchRequest {
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly nativeSessionId?: string;
}

export interface HarnessInstance {
	readonly processId: ProcessId;
	readonly nativeSessionId?: string;
	readonly events: AsyncIterable<HarnessEvent>;
	send(input: Input): Promise<void>;
	cancel(inputId: InputId): Promise<void>;
	shutdown(): Promise<void>;
}

export interface HarnessAdapter {
	readonly descriptor: PortDescriptor;
	launch(request: HarnessLaunchRequest): Promise<HarnessInstance>;
	resume?(request: HarnessLaunchRequest): Promise<HarnessInstance>;
}

export interface ProcessLaunchRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly stdio?: "ignore" | "pipe";
}

export interface ManagedProcess {
	readonly id: ProcessId;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly exit: Promise<{
		readonly code: number | null;
		readonly signal: string | null;
	}>;
	sendSignal(signal: string): Promise<void>;
}

export interface ProcessProvider {
	readonly descriptor: PortDescriptor;
	launch(request: ProcessLaunchRequest): Promise<ManagedProcess>;
}

export interface ScopedSecretRequest {
	readonly purpose: string;
	readonly resource: string;
}

export interface SecretGrant {
	/** Opaque reference; secret material is intentionally not part of the core port. */
	readonly reference: string;
	revoke(): Promise<void>;
}

export interface SecretProvider {
	readonly descriptor: PortDescriptor;
	grant(request: ScopedSecretRequest): Promise<SecretGrant>;
}

export interface InputObserver {
	onInputEvent(event: InputEvent): Promise<void>;
}
