export type Capability =
	| "session.list"
	| "session.get"
	| "session.create"
	| "session.stop"
	| "input.submit"
	| "input.cancel"
	| "transport.poll"
	| "harness.launch"
	| "harness.stop"
	| "harness.resume"
	| "harness.cancel"
	| "process.launch"
	| "process.signal"
	| "process.isolation"
	| "secret.scoped-grant";

export class UnsupportedCapabilityError extends Error {
	readonly code = "UNSUPPORTED_CAPABILITY";

	constructor(
		readonly capability: Capability,
		readonly adapterId: string,
	) {
		super(`Adapter '${adapterId}' does not support capability '${capability}'`);
		this.name = "UnsupportedCapabilityError";
	}
}

export class SessionStoreError extends Error {
	readonly code = "SESSION_STORE_ERROR";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionStoreError";
	}
}

export class InvalidStateDirectoryError extends Error {
	readonly code = "INVALID_STATE_DIRECTORY";

	constructor(
		readonly requestedPath: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "InvalidStateDirectoryError";
	}
}

export class InvalidWorkingDirectoryError extends Error {
	readonly code = "INVALID_WORKING_DIRECTORY";

	constructor(
		readonly requestedPath: string,
		options?: ErrorOptions,
	) {
		super(
			`Working directory is not an accessible directory: ${requestedPath}`,
			options,
		);
		this.name = "InvalidWorkingDirectoryError";
	}
}

export class SessionNotFoundError extends Error {
	readonly code = "SESSION_NOT_FOUND";

	constructor(readonly sessionId: string) {
		super(`Session '${sessionId}' does not exist`);
		this.name = "SessionNotFoundError";
	}
}

export class DuplicateSessionIdError extends Error {
	readonly code = "DUPLICATE_SESSION_ID";

	constructor(readonly sessionId: string) {
		super(`Session '${sessionId}' already exists`);
		this.name = "DuplicateSessionIdError";
	}
}

export class DuplicateAdapterIdError extends Error {
	readonly code = "DUPLICATE_ADAPTER_ID";

	constructor(readonly adapterId: string) {
		super(`Adapter ID '${adapterId}' is registered more than once`);
		this.name = "DuplicateAdapterIdError";
	}
}

export function requireCapability(
	capabilities: readonly Capability[],
	capability: Capability,
	adapterId: string,
): void {
	if (!capabilities.includes(capability)) {
		throw new UnsupportedCapabilityError(capability, adapterId);
	}
}
