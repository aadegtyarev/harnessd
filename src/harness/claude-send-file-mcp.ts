import { handleClaudeMcpRequest } from "./claude-send-file-mcp-request.js";
import { writeClaudeMcpMessage } from "./claude-send-file-mcp-write.js";

export async function handleClaudeMcpLine(
	line: string,
	output: NodeJS.WritableStream,
	shutdownSignal: AbortSignal = new AbortController().signal,
): Promise<void> {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		await writeClaudeMcpMessage(
			output,
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			},
			shutdownSignal,
		);
		return;
	}
	if (!isRecord(request)) {
		await writeClaudeMcpMessage(
			output,
			{
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "Invalid Request" },
			},
			shutdownSignal,
		);
		return;
	}
	const response = await handleClaudeMcpRequest(request, shutdownSignal);
	if (response !== undefined)
		await writeClaudeMcpMessage(output, response, shutdownSignal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeClaudeMcpParseError(
	output: NodeJS.WritableStream,
	signal: AbortSignal,
): Promise<void> {
	await writeClaudeMcpMessage(
		output,
		{
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		},
		signal,
	);
}
