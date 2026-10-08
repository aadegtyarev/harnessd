import { validateClaudeSendFileArguments } from "./claude-send-file-arguments.js";
import { forwardClaudeSendFile } from "./claude-send-file-forward.js";
import { CLAUDE_SEND_FILE_TOOL } from "./claude-send-file-tool.js";

const PROTOCOL_VERSION = "2025-06-18";

export async function handleClaudeMcpRequest(
	request: Record<string, unknown>,
	shutdownSignal: AbortSignal,
): Promise<unknown | undefined> {
	const hasId = Object.hasOwn(request, "id");
	const id = hasId && isId(request.id) ? request.id : null;
	if (
		request.jsonrpc !== "2.0" ||
		typeof request.method !== "string" ||
		request.method.length === 0 ||
		(hasId && !isId(request.id)) ||
		(request.params !== undefined && !isRecord(request.params))
	)
		return error(id, -32600, "Invalid Request");
	if (request.method === "notifications/initialized")
		return hasId ? error(id, -32600, "Invalid Request") : undefined;
	if (!hasId) return undefined;
	if (request.method === "initialize") {
		const params = request.params;
		if (
			!isRecord(params) ||
			typeof params.protocolVersion !== "string" ||
			!isRecord(params.capabilities) ||
			!isRecord(params.clientInfo) ||
			typeof params.clientInfo.name !== "string" ||
			typeof params.clientInfo.version !== "string"
		)
			return error(id, -32602, "Invalid params");
		return reply(id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "harnessd", version: "1.0.0" },
		});
	}
	if (request.method === "tools/list")
		return reply(id, { tools: [CLAUDE_SEND_FILE_TOOL] });
	if (request.method === "tools/call") {
		if (
			!isRecord(request.params) ||
			!validateClaudeSendFileArguments(request.params)
		)
			return error(id, -32602, "Invalid params");
		return reply(
			id,
			await forwardClaudeSendFile(request.params, shutdownSignal),
		);
	}
	return error(id, -32601, "Method not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number | null {
	return (
		value === null ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}

function reply(id: string | number | null, result: unknown): unknown {
	return { jsonrpc: "2.0", id, result };
}

function error(
	id: string | number | null,
	code: number,
	message: string,
): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
