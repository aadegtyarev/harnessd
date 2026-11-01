import { apiFailure } from "./api-failure.js";
import {
	LlmSessiondProtocolError,
	LlmSessiondTransportError,
} from "./errors.js";
import { readResponseText } from "./response-body.js";

export type FetchLike = typeof fetch;
export type ClientOptions = {
	baseUrl: string;
	timeoutMs?: number;
	fetch?: FetchLike;
};

export async function requestJson<T>(
	baseUrl: string,
	fetcher: FetchLike,
	timeoutMs: number,
	path: string,
	method: string,
	body: unknown,
	expected: number,
	schema: { parse(value: unknown): T },
): Promise<T> {
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	try {
		response = await fetcher(`${baseUrl}/api/v1${path}`, {
			method,
			headers:
				body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
			redirect: "error",
		});
	} catch (error) {
		const timeout =
			signal.aborted ||
			(error instanceof Error && error.name === "TimeoutError");
		throw new LlmSessiondTransportError(
			timeout ? "timeout" : "network",
			timeout ? "request timed out" : "request failed",
		);
	}
	if (response.status !== expected) return apiFailure(response, signal);
	if (expected === 204) return undefined as T;
	let value: unknown;
	const text = await readResponseText(response, signal);
	try {
		value = JSON.parse(text);
	} catch {
		throw new LlmSessiondProtocolError("json", "response was not valid JSON");
	}
	try {
		return schema.parse(value);
	} catch {
		throw new LlmSessiondProtocolError(
			"schema",
			"response did not match API v1 schema",
		);
	}
}
