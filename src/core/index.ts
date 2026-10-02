export type { Capability } from "./errors.js";
export {
	DuplicateAdapterIdError,
	DuplicateSessionIdError,
	InvalidStateDirectoryError,
	InvalidWorkingDirectoryError,
	requireCapability,
	SessionNotFoundError,
	SessionStoreError,
	UnsupportedCapabilityError,
} from "./errors.js";
export type {
	HarnessAdapter,
	HarnessControl,
	HarnessEffortCatalog,
	HarnessInstance,
	HarnessLaunchRequest,
	HarnessLiveStatus,
	HarnessModelCatalog,
	HarnessModelChangeResult,
	HarnessModelInfo,
	HarnessSelection,
	HarnessSessionStatus,
	HarnessUsageStats,
	InputObserver,
	InputPort,
	ManagedProcess,
	PortDescriptor,
	ProcessLaunchRequest,
	ProcessProvider,
	ScopedSecretRequest,
	SecretGrant,
	SecretProvider,
	SessionPort,
	TransportAdapter,
	TransportEvent,
	TransportEventListener,
	TransportEventSubscription,
	TransportResult,
} from "./ports.js";
export type {
	CreateSessionRequest,
	SessionEventListener,
} from "./session-manager.js";
export { SessionManager } from "./session-manager.js";
export type { SessionStore } from "./session-store.js";
export { resolveStateDirectory, SqliteSessionStore } from "./session-store.js";
export type {
	AdapterId,
	HarnessEvent,
	Input,
	InputDeliveryState,
	InputEvent,
	InputId,
	ProcessId,
	SessionId,
	SessionStatus,
	SessionSummary,
} from "./types.js";
