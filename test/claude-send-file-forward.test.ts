import { describe, expect, it } from "vitest";
import { handleClaudeMcpLine } from "../src/harness/claude-send-file-mcp.js";
import {
	callTool,
	captureOutput,
	launchFileHandler,
	launchRequest,
	withBridgeEnvironment,
} from "./claude-send-file-test-fixture.js";

describe("Claude send_file forwarding", () => {
	it("lists exactly one tool and rejects malformed arguments before forwarding", async () => {
		let calls = 0;
		const { instance, config } = await launchFileHandler(async () => {
			calls += 1;
			return { fileName: "f", delivered: 1, recipients: 1 };
		});
		const output = captureOutput();
		await withBridgeEnvironment(config.env, async () => {
			await handleClaudeMcpLine(
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				output.stream,
			);
			await callTool(output.stream, 2, { path: "f", extra: true });
		});
		await instance.shutdown();
		const messages = output
			.text()
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						result?: { tools?: { name: string }[] };
						error?: { code: number };
					},
			);
		expect(messages[0]?.result?.tools?.map((tool) => tool.name)).toEqual([
			"send_file",
		]);
		expect(messages[1]?.error?.code).toBe(-32602);
		expect(calls).toBe(0);
	});

	it("forwards the exact session/path/caption once and returns a safe success", async () => {
		const calls: unknown[] = [];
		const { instance, config } = await launchFileHandler(async (request) => {
			calls.push(request);
			return { fileName: "photo.png", delivered: 1, recipients: 1 };
		});
		const output = captureOutput();
		await withBridgeEnvironment(config.env, () =>
			callTool(output.stream, "safe-id", {
				path: "folder/a.png",
				caption: "caption",
			}),
		);
		await instance.shutdown();
		expect(calls).toEqual([
			{
				sessionId: launchRequest.sessionId,
				path: "folder/a.png",
				caption: "caption",
			},
		]);
		expect(JSON.parse(output.text())).toMatchObject({
			jsonrpc: "2.0",
			id: "safe-id",
			result: {
				content: [{ text: "File photo.png sent to 1 selected chat(s)." }],
			},
		});
	});

	it("returns a partial delivery result without repeating the handler", async () => {
		let calls = 0;
		const { instance, config } = await launchFileHandler(async () => {
			calls += 1;
			return { fileName: "safe", delivered: 1, recipients: 2 };
		});
		const output = captureOutput();
		await withBridgeEnvironment(config.env, () =>
			callTool(output.stream, 2, { path: "f" }),
		);
		await instance.shutdown();
		expect(calls).toBe(1);
		expect(output.text()).toContain(
			"File delivery was partial (1/2); do not retry.",
		);
	});
});
