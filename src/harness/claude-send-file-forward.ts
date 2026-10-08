import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "./agent-file-send-protocol.js";
import { validateClaudeSendFileArguments } from "./claude-send-file-arguments.js";

const FORWARD_TIMEOUT_MS = 30_000;

export async function forwardClaudeSendFile(
	params: unknown,
	shutdownSignal: AbortSignal,
	timeoutMs = FORWARD_TIMEOUT_MS,
): Promise<unknown> {
	const args = validateClaudeSendFileArguments(params);
	if (!args) return toolError("Invalid file request");
	const url = process.env[AGENT_FILE_SEND_URL_ENV];
	const token = process.env[AGENT_FILE_SEND_TOKEN_ENV];
	if (!url || !token) return toolError("File sending is unavailable");
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(args),
			signal: AbortSignal.any([shutdownSignal, timeout]),
		});
		const body: unknown = await response.json();
		if (
			!response.ok ||
			!isRecord(body) ||
			body.ok !== true ||
			!isRecord(body.result)
		)
			return uncertain();
		const { fileName, delivered, recipients } = body.result;
		if (
			typeof fileName !== "string" ||
			fileName.length === 0 ||
			fileName.length > 4096 ||
			typeof delivered !== "number" ||
			typeof recipients !== "number" ||
			!Number.isSafeInteger(delivered) ||
			!Number.isSafeInteger(recipients) ||
			delivered < 0 ||
			recipients < 0 ||
			delivered > recipients
		)
			return uncertain();
		if (delivered < recipients)
			return toolError(
				`File delivery was partial (${delivered}/${recipients}); do not retry.`,
			);
		return toolResult(
			`File ${fileName} sent to ${delivered} selected chat(s).`,
		);
	} catch {
		return uncertain();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uncertain(): unknown {
	return toolError("File delivery may be uncertain; do not retry.");
}

function toolError(message: string): unknown {
	return { content: [{ type: "text", text: message }], isError: true };
}

function toolResult(message: string): unknown {
	return { content: [{ type: "text", text: message }] };
}
