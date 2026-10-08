import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "./agent-file-send-protocol.js";

const PROTOCOL_VERSION = "2025-06-18";

export async function handleClaudeMcpLine(
	line: string,
	output: NodeJS.WritableStream,
): Promise<void> {
	let request: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) return;
		request = parsed;
	} catch {
		write(output, {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		});
		return;
	}
	if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
	if (
		request.method === "notifications/initialized" ||
		request.id === undefined
	)
		return;
	let result: unknown;
	if (request.method === "initialize") {
		result = {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "harnessd", version: "1.0.0" },
		};
	} else if (request.method === "tools/list") {
		result = {
			tools: [
				{
					name: "send_file",
					description:
						"Send one workspace file to authorized chats selecting this session. Do not retry partial or uncertain delivery.",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								minLength: 1,
								maxLength: 4096,
								description: "Path relative to this session workspace",
							},
							caption: { type: "string", maxLength: 1024 },
						},
						required: ["path"],
						additionalProperties: false,
					},
				},
			],
		};
	} else if (request.method === "tools/call") {
		result = await callSendFile(request.params);
	} else {
		write(output, {
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32601, message: "Method not found" },
		});
		return;
	}
	write(output, { jsonrpc: "2.0", id: request.id, result });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callSendFile(params: unknown): Promise<unknown> {
	const args =
		isRecord(params) && isRecord(params.arguments)
			? params.arguments
			: undefined;
	if (
		!isRecord(params) ||
		params.name !== "send_file" ||
		!args ||
		typeof args.path !== "string" ||
		args.path.length < 1 ||
		args.path.length > 4096 ||
		(args.caption !== undefined &&
			(typeof args.caption !== "string" || [...args.caption].length > 1024)) ||
		Object.keys(args).some((key) => key !== "path" && key !== "caption")
	)
		return toolError("Invalid file request");
	const url = process.env[AGENT_FILE_SEND_URL_ENV];
	const token = process.env[AGENT_FILE_SEND_TOKEN_ENV];
	if (!url || !token) return toolError("File sending is unavailable");
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(args),
		});
		const body: unknown = await response.json();
		if (
			!response.ok ||
			!isRecord(body) ||
			body.ok !== true ||
			!isRecord(body.result)
		)
			return toolError("File could not be sent");
		const { fileName, delivered, recipients } = body.result;
		if (
			typeof fileName !== "string" ||
			typeof delivered !== "number" ||
			typeof recipients !== "number"
		)
			return toolError("File could not be sent");
		const partial = delivered < recipients;
		return {
			content: [
				{
					type: "text",
					text: partial
						? `File delivery was partial (${delivered}/${recipients}); do not retry.`
						: `File ${fileName} sent to ${delivered} selected chat(s).`,
				},
			],
			...(partial ? { isError: true } : {}),
		};
	} catch {
		return toolError(
			"File could not be sent; delivery may be uncertain. Do not retry.",
		);
	}
}

function toolError(message: string): unknown {
	return { content: [{ type: "text", text: message }], isError: true };
}

function write(output: NodeJS.WritableStream, value: unknown): void {
	output.write(`${JSON.stringify(value)}\n`);
}
