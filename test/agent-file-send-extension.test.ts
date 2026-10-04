import { afterEach, describe, expect, it } from "vitest";
import type { SessionId } from "../src/core/types.js";
import { startAgentFileSendBridge } from "../src/harness/agent-file-send-bridge.js";
import extension from "../src/harness/agent-file-send-extension.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";

const bridges: Awaited<ReturnType<typeof startAgentFileSendBridge>>[] = [];
const originalUrl = process.env[AGENT_FILE_SEND_URL_ENV];
const originalToken = process.env[AGENT_FILE_SEND_TOKEN_ENV];
afterEach(async () => {
	await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
	if (originalUrl === undefined) delete process.env[AGENT_FILE_SEND_URL_ENV];
	else process.env[AGENT_FILE_SEND_URL_ENV] = originalUrl;
	if (originalToken === undefined)
		delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
	else process.env[AGENT_FILE_SEND_TOKEN_ENV] = originalToken;
});

type RegisteredTool = Parameters<
	Parameters<typeof extension>[0]["registerTool"]
>[0];

function registerSendTool() {
	let tool: RegisteredTool | undefined;
	extension({
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
	} as never);
	if (!tool) throw new Error("send_file tool was not registered");
	return tool;
}

describe("send_file Pi extension", () => {
	it("sends the tool path and caption and reports successful delivery", async () => {
		const bridge = await startAgentFileSendBridge(
			"sid" as SessionId,
			async () => ({ fileName: "report.txt", delivered: 1, recipients: 1 }),
		);
		bridges.push(bridge);
		process.env[AGENT_FILE_SEND_URL_ENV] = bridge.url;
		process.env[AGENT_FILE_SEND_TOKEN_ENV] = bridge.token;
		const tool = registerSendTool();
		const result = await tool.execute(
			"tool-call",
			{ path: "report.txt", caption: "Requested" } as never,
			new AbortController().signal,
		);
		expect(result.content).toEqual([
			{ type: "text", text: "File report.txt sent to 1 selected chat(s)." },
		]);
		expect(result.isError).toBeUndefined();
	});

	it("reports partial delivery without inviting an automatic retry", async () => {
		const bridge = await startAgentFileSendBridge(
			"sid" as SessionId,
			async () => ({ fileName: "report.txt", delivered: 1, recipients: 2 }),
		);
		bridges.push(bridge);
		process.env[AGENT_FILE_SEND_URL_ENV] = bridge.url;
		process.env[AGENT_FILE_SEND_TOKEN_ENV] = bridge.token;
		const result = await registerSendTool().execute(
			"tool-call",
			{ path: "report.txt" } as never,
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"Delivery was partial; do not retry automatically.",
		);
	});

	it("does not expose bridge errors or environment values to the model", async () => {
		process.env[AGENT_FILE_SEND_URL_ENV] = "http://127.0.0.1:1/send-file";
		process.env[AGENT_FILE_SEND_TOKEN_ENV] = "secret-marker";
		const result = await registerSendTool().execute(
			"tool-call",
			{ path: "report.txt" } as never,
			new AbortController().signal,
		);
		expect(result.content[0]?.text).toBe(
			"File delivery is uncertain; do not retry automatically.",
		);
		expect(result.content[0]?.text).not.toContain("secret-marker");
	});
});
