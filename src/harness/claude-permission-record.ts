import type { ToolPermissionRequest } from "../core/ports.js";
import type { InputId, SessionId } from "../core/types.js";

export function createPermissionRequest(
	sessionId: SessionId,
	inputId: InputId,
	requestId: string,
	request: Record<string, unknown>,
	signal: AbortSignal,
): ToolPermissionRequest | undefined {
	const toolName = request.tool_name;
	const input = request.input;
	if (typeof toolName !== "string" || !isRecord(input)) return undefined;
	if (Buffer.byteLength(JSON.stringify(input)) > 32_768) return undefined;
	return {
		sessionId,
		inputId,
		requestId,
		toolName: toolName.slice(0, 128),
		input: input as ToolPermissionRequest["input"],
		context: readPermissionContext(request),
		signal,
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readPermissionContext(
	request: Record<string, unknown>,
): ToolPermissionRequest["context"] {
	const context: Record<string, unknown> = {};
	for (const [source, target] of [
		["tool_use_id", "toolUseId"],
		["agent_id", "agentId"],
		["blocked_path", "blockedPath"],
		["decision_reason", "decisionReason"],
		["title", "title"],
		["display_name", "displayName"],
		["description", "description"],
	] as const) {
		const value = request[source];
		if (typeof value === "string") context[target] = value.slice(0, 512);
	}
	if (Array.isArray(request.permission_suggestions))
		context.suggestions = request.permission_suggestions.slice(0, 8);
	return context as ToolPermissionRequest["context"];
}
