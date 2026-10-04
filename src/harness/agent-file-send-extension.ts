import { type Static, Type } from "typebox";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "./agent-file-send-protocol.js";

const parameters = Type.Object({
	path: Type.String({
		description: "File path relative to this session's working directory",
		minLength: 1,
		maxLength: 4096,
	}),
	caption: Type.Optional(
		Type.String({
			description: "Optional Telegram caption",
			maxLength: 1024,
		}),
	),
});

type Parameters = Static<typeof parameters>;
type FileSendDetails = {
	readonly fileName?: string;
	readonly delivered?: number;
	readonly recipients?: number;
	readonly error?: string;
};
type ToolResult = {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details: FileSendDetails;
	readonly isError?: boolean;
};

interface PiExtensionApi {
	registerTool(tool: {
		readonly name: string;
		readonly label: string;
		readonly description: string;
		readonly parameters: typeof parameters;
		readonly annotations: {
			readonly readOnlyHint: false;
			readonly destructiveHint: false;
			readonly idempotentHint: false;
			readonly openWorldHint: true;
		};
		execute(
			toolCallId: string,
			params: Parameters,
			signal: AbortSignal,
		): Promise<ToolResult>;
	}): void;
}

export default function (pi: PiExtensionApi): void {
	pi.registerTool({
		name: "send_file",
		label: "Send file to Telegram",
		description:
			"Send a regular file from this session's working directory to authorized Telegram chats currently selecting this session. Use only when the user explicitly asks to send a file. Files must be within the workspace and no larger than 20 MiB. Do not retry if delivery is partial or uncertain.",
		parameters,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		async execute(_toolCallId, params, signal) {
			const url = process.env[AGENT_FILE_SEND_URL_ENV];
			const token = process.env[AGENT_FILE_SEND_TOKEN_ENV];
			if (!url || !token) return errorResult("File sending is unavailable.");
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(params),
					signal,
				});
				const body: unknown = await response.json();
				if (!response.ok || !isSuccess(body)) {
					const error = getError(body);
					return errorResult(error ?? "File could not be sent.");
				}
				const result = body.result;
				if (result.delivered < result.recipients) {
					return {
						content: [
							{
								type: "text",
								text: `File ${result.fileName} was sent to ${result.delivered} of ${result.recipients} selected chats. Delivery was partial; do not retry automatically.`,
							},
						],
						details: result,
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `File ${result.fileName} sent to ${result.delivered} selected chat(s).`,
						},
					],
					details: result,
				};
			} catch {
				return errorResult(
					"File delivery is uncertain; do not retry automatically.",
				);
			}
		},
	});
}

function isSuccess(value: unknown): value is {
	readonly ok: true;
	readonly result: FileSendDetails & {
		readonly fileName: string;
		readonly delivered: number;
		readonly recipients: number;
	};
} {
	if (typeof value !== "object" || value === null || !("result" in value))
		return false;
	const result = value.result;
	return (
		"ok" in value &&
		value.ok === true &&
		typeof result === "object" &&
		result !== null &&
		"fileName" in result &&
		typeof result.fileName === "string" &&
		"delivered" in result &&
		typeof result.delivered === "number" &&
		Number.isSafeInteger(result.delivered) &&
		result.delivered >= 0 &&
		"recipients" in result &&
		typeof result.recipients === "number" &&
		Number.isSafeInteger(result.recipients) &&
		result.recipients > 0 &&
		result.delivered <= result.recipients
	);
}

function getError(value: unknown): string | undefined {
	if (
		typeof value === "object" &&
		value !== null &&
		"error" in value &&
		typeof value.error === "string" &&
		"ok" in value &&
		value.ok === false
	)
		return value.error;
	return undefined;
}

function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}
