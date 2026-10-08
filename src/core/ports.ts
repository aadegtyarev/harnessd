import type { Readable, Writable } from "node:stream";
import type { Capability } from "./errors.js";
import type {
	AdapterId,
	AdapterOptions,
	AdapterOptionValue,
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
	readonly aliases?: readonly string[];
	readonly capabilities: readonly Capability[];
	readonly metadata?: Readonly<Record<string, string>>;
	readonly options?: readonly HarnessOptionDescriptor[];
}

export interface HarnessOptionDescriptor {
	readonly key: string;
	readonly label: string;
	readonly values: readonly AdapterOptionValue[];
	readonly allowCustom?: boolean;
	readonly defaultValue?: AdapterOptionValue;
	readonly dangerousValues?: readonly AdapterOptionValue[];
}

export interface HarnessOptionUpdate {
	readonly set?: AdapterOptions;
	readonly resetKeys?: readonly string[];
	readonly confirmedDangerous?: boolean;
}

export interface ToolPermissionContext {
	readonly suggestions?: readonly AdapterOptionValue[];
	readonly toolUseId?: string;
	readonly agentId?: string;
	readonly blockedPath?: string;
	readonly decisionReason?: string;
	readonly title?: string;
	readonly displayName?: string;
	readonly description?: string;
}

export interface ToolPermissionRequest {
	readonly sessionId: SessionId;
	readonly inputId: InputId;
	readonly requestId: string;
	readonly toolName: string;
	readonly input: Readonly<Record<string, AdapterOptionValue>>;
	readonly context: ToolPermissionContext;
	readonly signal: AbortSignal;
}

export type ToolPermissionDecision =
	| { readonly behavior: "allow" }
	| {
			readonly behavior: "deny";
			readonly message: string;
			readonly interrupt: false;
	  };
export type ToolPermissionHandler = (
	request: ToolPermissionRequest,
) => Promise<ToolPermissionDecision>;
export interface ToolPermissionTransport {
	requestToolPermission(
		request: ToolPermissionRequest,
	): Promise<ToolPermissionDecision>;
}

export interface HarnessRegistryEntry {
	readonly id: AdapterId;
	readonly aliases: readonly string[];
	readonly capabilities: readonly Capability[];
	readonly metadata?: Readonly<Record<string, string>>;
	readonly options?: readonly HarnessOptionDescriptor[];
}

export interface SessionPort {
	readonly descriptor: PortDescriptor;
	list(): Promise<readonly SessionSummary[]>;
	get(id: SessionId): Promise<SessionSummary | undefined>;
	create(input: {
		readonly harnessId?: AdapterId;
		readonly cwd: string;
		readonly name?: string;
		readonly adapterOptions?: AdapterOptions;
		readonly confirmedDangerousOptions?: boolean;
	}): Promise<SessionSummary>;
	rename(id: SessionId, name?: string): Promise<SessionSummary>;
	stop(id: SessionId): Promise<void>;
	resume(id: SessionId): Promise<SessionSummary>;
	listAdapterOptions?(id: SessionId): Promise<HarnessOptionCatalog>;
	updateAdapterOptions?(
		id: SessionId,
		update: HarnessOptionUpdate,
	): Promise<SessionSummary>;
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
			readonly harnessId?: AdapterId;
			readonly cwd: string;
			readonly name?: string;
			readonly adapterOptions?: AdapterOptions;
			readonly confirmedDangerousOptions?: boolean;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "rename";
			readonly sessionId: SessionId;
			readonly name?: string;
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
			readonly kind: "resume";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "delete";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "submit";
			readonly sessionId: SessionId;
			readonly text: string;
			readonly images?: readonly {
				readonly mimeType: string;
				readonly data: string;
			}[];
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "cancel";
			readonly sessionId: SessionId;
			readonly inputId: InputId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "cancel_current";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "session_status";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "model_list";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "model_set";
			readonly sessionId: SessionId;
			readonly provider: string;
			readonly modelId: string;
			readonly effort?: string;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "effort_list";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "effort_set";
			readonly sessionId: SessionId;
			readonly effort: string;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "adapter_options_list";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "adapter_options_set";
			readonly sessionId: SessionId;
			readonly update: HarnessOptionUpdate;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "reload";
			readonly sessionId: SessionId;
			readonly beforeDispatch: () => boolean;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "command_list";
			readonly sessionId: SessionId;
	  }
	| {
			readonly requestId: string;
			readonly principalId: string;
			readonly kind: "command_run";
			readonly sessionId: SessionId;
			readonly name: string;
			readonly remainder: string;
			readonly beforeDispatch?: () => boolean;
	  };

export type TransportResult =
	| {
			readonly requestId: string;
			readonly ok: true;
			readonly resumed?: boolean;
			readonly value:
				| readonly SessionSummary[]
				| SessionSummary
				| HarnessSessionStatus
				| HarnessModelCatalog
				| HarnessEffortCatalog
				| HarnessOptionCatalog
				| readonly HarnessCommand[]
				| HarnessCommandResult
				| HarnessModelChangeResult
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
				readonly resumed?: true;
			};
	  };

export type TransportEventListener = (event: HarnessEvent) => unknown;
export type TransportEventSubscription = (
	listener: TransportEventListener,
) => () => void;

export interface AgentFileSendRequest {
	readonly sessionId: SessionId;
	readonly path: string;
	readonly caption?: string;
}

export interface AgentFileSendResult {
	readonly fileName: string;
	readonly delivered: number;
	readonly recipients: number;
}

export type AgentFileSendHandler = (
	request: AgentFileSendRequest,
) => Promise<AgentFileSendResult>;

export interface AgentFileSendTransport {
	sendAgentFile(request: AgentFileSendRequest): Promise<AgentFileSendResult>;
}

export interface TransportAdapter {
	readonly descriptor: PortDescriptor;
	start(
		dispatch: (event: TransportEvent) => Promise<TransportResult>,
		subscribeEvents: TransportEventSubscription,
		listSessions?: () => Promise<readonly SessionSummary[]>,
		getSessionCapabilities?: (
			sessionId: SessionId,
		) => Promise<readonly Capability[]>,
		listHarnesses?: () => readonly HarnessRegistryEntry[],
	): Promise<void>;
	stop(): Promise<void>;
}

export interface HarnessLaunchRequest {
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly nativeSessionId?: string;
	readonly adapterOptions?: AdapterOptions;
	readonly toolPermissionHandler?: ToolPermissionHandler;
}

export interface HarnessModelInfo {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface HarnessUsageStats {
	readonly totalTokens?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly costUsd?: number;
	readonly contextTokens?: number | null;
	readonly contextWindow?: number;
	readonly contextPercent?: number | null;
}

export interface HarnessSelection {
	readonly model?: HarnessModelInfo;
	readonly effort?: string;
}

export interface HarnessLiveStatus extends HarnessSelection {
	readonly usage?: HarnessUsageStats;
}

export interface HarnessCommand {
	readonly name: string;
	readonly description: string;
}

export interface HarnessCommandResult {
	readonly disposition: "handled" | "accepted";
	readonly output?: string;
}

export interface HarnessControl {
	getCommands?(): Promise<readonly HarnessCommand[]>;
	runCommand?(
		name: string,
		remainder: string,
		beforeDispatch?: () => boolean,
	): Promise<HarnessCommandResult>;
	getSelection(): Promise<HarnessSelection>;
	getStatus(): Promise<HarnessLiveStatus>;
	listModels(): Promise<readonly HarnessModelInfo[]>;
	listEfforts(): Promise<readonly string[]>;
	setModel(provider: string, modelId: string): Promise<HarnessModelInfo>;
	setEffort(level: string): Promise<void>;
	reload?(beforeDispatch?: () => void): Promise<void>;
}

export interface HarnessSessionStatus {
	readonly session: SessionSummary;
	readonly live?: HarnessLiveStatus;
}

export interface HarnessModelCatalog {
	readonly models: readonly HarnessModelInfo[];
	readonly current?: HarnessModelInfo;
}

export interface HarnessOptionCatalog {
	readonly descriptors: readonly HarnessOptionDescriptor[];
	readonly defaults?: AdapterOptions;
	readonly overrides?: AdapterOptions;
	readonly effective?: AdapterOptions;
}

export interface HarnessEffortCatalog {
	readonly levels: readonly string[];
	readonly current?: string;
}

export interface HarnessModelChangeResult {
	readonly model: HarnessModelInfo;
	readonly effort?: string;
	readonly effortConfirmed?: boolean;
}

export interface HarnessInstance {
	readonly processId: ProcessId;
	readonly exit: Promise<{
		readonly code: number | null;
		readonly signal: string | null;
	}>;
	readonly nativeSessionId?: string;
	readonly events: AsyncIterable<HarnessEvent>;
	readonly control?: HarnessControl;
	isIdle?(): boolean;
	send(input: Input): Promise<void>;
	cancel(inputId: InputId): Promise<void>;
	cancelCurrent?(): Promise<void>;
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
