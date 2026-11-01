import { LlmSessiondApiError, LlmSessiondProtocolError } from "./errors.js";
import { apiErrorSchema } from "./schemas.js";

export async function apiFailure(response: Response): Promise<never> {
	if (response.status === 204)
		throw new LlmSessiondProtocolError("status", "unexpected HTTP status");
	let value: unknown;
	try {
		value = JSON.parse(await response.text());
	} catch {
		throw new LlmSessiondProtocolError(
			"json",
			"error response was not valid JSON",
		);
	}
	const parsed = apiErrorSchema.safeParse(value);
	if (!parsed.success)
		throw new LlmSessiondProtocolError(
			"schema",
			"error response did not match API v1 schema",
		);
	if (!validStatus(parsed.data.error.code, response.status))
		throw new LlmSessiondProtocolError(
			"status",
			"unexpected HTTP status or API error code",
		);
	throw new LlmSessiondApiError(
		response.status,
		parsed.data.error.code,
		parsed.data.error.message,
	);
}

function validStatus(code: string, status: number): boolean {
	const groups: Record<number, string[]> = {
		400: ["INVALID_CWD", "INVALID_JSON", "INVALID_PATH", "VALIDATION_ERROR"],
		404: ["NOT_FOUND"],
		409: [
			"CANCEL_FAILED",
			"INPUT_BUSY",
			"INPUT_NOT_CURRENT",
			"INPUT_UNCERTAIN",
			"RESUME_FAILED",
			"SESSION_NOT_RESUMABLE",
			"SESSION_NOT_RUNNING",
		],
		413: ["LIMIT_EXCEEDED"],
		500: ["INPUT_FAILED", "INTERNAL_ERROR"],
	};
	return groups[status]?.includes(code) ?? false;
}
