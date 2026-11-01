import { LlmSessiondTransportError } from "./errors.js";

export async function readResponseText(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	try {
		return await response.text();
	} catch {
		const timeout = signal.aborted;
		throw new LlmSessiondTransportError(
			timeout ? "timeout" : "network",
			timeout ? "request timed out" : "response body could not be read",
		);
	}
}
