import { PassThrough } from "node:stream";
import type { AgentFileSendHandler } from "../src/core/ports.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { handleClaudeMcpLine } from "../src/harness/claude-send-file-mcp.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

export async function launchFileHandler(handler: AgentFileSendHandler) {
	const fake = fakeProvider();
	const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
		executable: "claude",
		agentFileSend: handler,
	}).launch(launchRequest);
	const args = fake.args() ?? [];
	const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}") as {
		mcpServers: { harnessd: { env: Record<string, string> } };
	};
	return { fake, instance, config: config.mcpServers.harnessd };
}

export async function withBridgeEnvironment<T>(
	env: Record<string, string>,
	run: () => Promise<T>,
): Promise<T> {
	const previous = [
		process.env[AGENT_FILE_SEND_URL_ENV],
		process.env[AGENT_FILE_SEND_TOKEN_ENV],
	];
	process.env[AGENT_FILE_SEND_URL_ENV] = env[AGENT_FILE_SEND_URL_ENV];
	process.env[AGENT_FILE_SEND_TOKEN_ENV] = env[AGENT_FILE_SEND_TOKEN_ENV];
	try {
		return await run();
	} finally {
		if (previous[0] === undefined) delete process.env[AGENT_FILE_SEND_URL_ENV];
		else process.env[AGENT_FILE_SEND_URL_ENV] = previous[0];
		if (previous[1] === undefined)
			delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
		else process.env[AGENT_FILE_SEND_TOKEN_ENV] = previous[1];
	}
}

export function captureOutput() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk: Buffer) => {
		text += chunk.toString();
	});
	return { stream, text: () => text };
}

export async function callTool(
	output: NodeJS.WritableStream,
	id: string | number,
	args: unknown,
): Promise<void> {
	await handleClaudeMcpLine(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: "send_file", arguments: args },
		}),
		output,
	);
}

export {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
	fakeProvider,
	launchRequest,
};
