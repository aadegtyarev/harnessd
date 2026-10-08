import { describe, expect, it } from "vitest";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { handleClaudeMcpLine } from "../src/harness/claude-send-file-mcp.js";
import { startClaudeSendFileMcpServer } from "../src/harness/claude-send-file-mcp-server.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude session MCP file sending", () => {
	it("configures only send_file with a fresh per-launch bridge credential", async () => {
		const first = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(first.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "a.txt",
				delivered: 1,
				recipients: 1,
			}),
		});
		expect(adapter.descriptor.capabilities).toContain("harness.file.send");
		const instance = await adapter.launch(launchRequest);
		const args = first.args() ?? [];
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("mcp__harnessd__send_file");
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		expect(Object.keys(config.mcpServers)).toEqual(["harnessd"]);
		const token = config.mcpServers.harnessd.env[AGENT_FILE_SEND_TOKEN_ENV];
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		await instance.shutdown();
		const second = fakeProvider();
		const other = await new ClaudeCodeHarnessAdapter(second.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "a.txt",
				delivered: 1,
				recipients: 1,
			}),
		}).launch(launchRequest);
		const secondArgs = second.args() ?? [];
		const secondConfig = JSON.parse(
			secondArgs[secondArgs.indexOf("--mcp-config") + 1] ?? "{}",
		) as typeof config;
		expect(
			secondConfig.mcpServers.harnessd.env[AGENT_FILE_SEND_TOKEN_ENV],
		).not.toBe(token);
		await other.shutdown();
	});

	it("does not add MCP arguments or capability without a generic handler", async () => {
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		expect(adapter.descriptor.capabilities).not.toContain("harness.file.send");
		const instance = await adapter.launch(launchRequest);
		expect(fake.args()).not.toContain("--mcp-config");
		await instance.shutdown();
	});

	it("forwards exact session path/caption once and returns only safe MCP results", async () => {
		const calls: unknown[] = [];
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async (request) => {
				calls.push(request);
				return { fileName: "photo.png", delivered: 1, recipients: 1 };
			},
		}).launch(launchRequest);
		const args = fake.args() ?? [];
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		const environment = config.mcpServers.harnessd.env;
		const previous = [
			process.env[AGENT_FILE_SEND_URL_ENV],
			process.env[AGENT_FILE_SEND_TOKEN_ENV],
		];
		process.env[AGENT_FILE_SEND_URL_ENV] = environment[AGENT_FILE_SEND_URL_ENV];
		process.env[AGENT_FILE_SEND_TOKEN_ENV] =
			environment[AGENT_FILE_SEND_TOKEN_ENV];
		const output = new (await import("node:stream")).PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		try {
			await handleClaudeMcpLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 8,
					method: "tools/call",
					params: {
						name: "send_file",
						arguments: { path: "folder/a.png", caption: "caption" },
					},
				}),
				output,
			);
		} finally {
			await instance.shutdown();
			if (previous[0] === undefined)
				delete process.env[AGENT_FILE_SEND_URL_ENV];
			else process.env[AGENT_FILE_SEND_URL_ENV] = previous[0];
			if (previous[1] === undefined)
				delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
			else process.env[AGENT_FILE_SEND_TOKEN_ENV] = previous[1];
		}
		expect(calls).toEqual([
			{
				sessionId: launchRequest.sessionId,
				path: "folder/a.png",
				caption: "caption",
			},
		]);
		expect(JSON.parse(response)).toMatchObject({
			jsonrpc: "2.0",
			id: 8,
			result: {
				content: [{ text: "File photo.png sent to 1 selected chat(s)." }],
			},
		});
	});

	it("lists one tool, bounds malformed arguments and never retries partial results", async () => {
		let calls = 0;
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async () => {
				calls += 1;
				return { fileName: "safe", delivered: 1, recipients: 2 };
			},
		}).launch(launchRequest);
		const args = fake.args() ?? [];
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		const previousUrl = process.env[AGENT_FILE_SEND_URL_ENV];
		const previousToken = process.env[AGENT_FILE_SEND_TOKEN_ENV];
		process.env[AGENT_FILE_SEND_URL_ENV] =
			config.mcpServers.harnessd.env[AGENT_FILE_SEND_URL_ENV];
		process.env[AGENT_FILE_SEND_TOKEN_ENV] =
			config.mcpServers.harnessd.env[AGENT_FILE_SEND_TOKEN_ENV];
		const output = new (await import("node:stream")).PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		try {
			await handleClaudeMcpLine(
				JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
				output,
			);
			await handleClaudeMcpLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: { name: "send_file", arguments: { path: "ok", extra: true } },
				}),
				output,
			);
			await handleClaudeMcpLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: "send_file", arguments: { path: "ok" } },
				}),
				output,
			);
		} finally {
			await instance.shutdown();
			if (previousUrl === undefined)
				delete process.env[AGENT_FILE_SEND_URL_ENV];
			else process.env[AGENT_FILE_SEND_URL_ENV] = previousUrl;
			if (previousToken === undefined)
				delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
			else process.env[AGENT_FILE_SEND_TOKEN_ENV] = previousToken;
		}
		const replies = response
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						result: { tools?: unknown[]; isError?: boolean };
					},
			);
		expect(replies[0]?.result.tools).toHaveLength(1);
		expect(replies[1]?.result.isError).toBe(true);
		expect(replies[2]?.result.isError).toBe(true);
		expect(calls).toBe(1);
	});

	it("returns fixed parse errors for malformed and oversized MCP frames", async () => {
		const { PassThrough } = await import("node:stream");
		const input = new PassThrough();
		const output = new PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		startClaudeSendFileMcpServer(input, output);
		input.write(`${"x".repeat(16 * 1024 + 1)}\n`);
		await handleClaudeMcpLine("not-json", output);
		expect(response.match(/Parse error/g)).toHaveLength(2);
	});

	it("closes the bridge when the Claude process exits", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "a",
				delivered: 1,
				recipients: 1,
			}),
		}).launch(launchRequest);
		const args = fake.args() ?? [];
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		const env = config.mcpServers.harnessd.env;
		fake.finish();
		await fake.process.exit;
		await new Promise((resolve) => setImmediate(resolve));
		await expect(
			fetch(env[AGENT_FILE_SEND_URL_ENV] ?? "", {
				method: "POST",
				headers: {
					authorization: `Bearer ${env[AGENT_FILE_SEND_TOKEN_ENV]}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ path: "a" }),
			}),
		).rejects.toThrow();
		await instance.shutdown();
	});
});
