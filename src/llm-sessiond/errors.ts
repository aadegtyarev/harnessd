export class LlmSessiondApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly safeMessage: string,
	) {
		super(`llm-sessiond API error ${status}: ${code}`);
		this.name = "LlmSessiondApiError";
	}
}

export class LlmSessiondProtocolError extends Error {
	constructor(
		readonly kind: "schema" | "json" | "status",
		message: string,
	) {
		super(`llm-sessiond protocol error: ${message}`);
		this.name = "LlmSessiondProtocolError";
	}
}

export class LlmSessiondTransportError extends Error {
	constructor(
		readonly kind: "network" | "timeout",
		message: string,
	) {
		super(`llm-sessiond transport error: ${message}`);
		this.name = "LlmSessiondTransportError";
	}
}
