import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleClaudeMcpLine } from "../src/harness/claude-send-file-mcp.js";
import { startClaudeSendFileMcpServer } from "../src/harness/claude-send-file-mcp-server.js";
import {
	launchFileHandler,
	withBridgeEnvironment,
} from "./claude-send-file-test-fixture.js";

describe("Claude MCP JSON-RPC frames", () => {
	it("echoes string/integer IDs and rejects invalid IDs and envelopes", async () => {
		const output = new PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		for (const id of ["client-request", 7])
			await handleClaudeMcpLine(
				JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
				output,
			);
		for (const request of [
			{ jsonrpc: "2.0", id: {}, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1.5, method: "tools/list" },
			{ jsonrpc: "1.0", id: 9, method: "tools/list" },
			{ jsonrpc: "2.0", id: true, method: "tools/list" },
			{ jsonrpc: "2.0", id: null, method: "tools/list" },
			{ jsonrpc: "2.0", id: 10, method: "tools/list", params: [] },
			{ jsonrpc: "2.0", id: 11, method: "" },
		])
			await handleClaudeMcpLine(JSON.stringify(request), output);
		const replies = response
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: unknown; error?: unknown });
		expect(replies.slice(0, 2).map((reply) => reply.id)).toEqual([
			"client-request",
			7,
		]);
		expect(replies.slice(2).map((reply) => reply.error)).toEqual(
			Array(7).fill({ code: -32600, message: "Invalid Request" }),
		);
	});

	it("rejects null tools/call ID before bridge or handler forwarding", async () => {
		let delivered = 0;
		const { instance, config } = await launchFileHandler(async () => {
			delivered += 1;
			return { fileName: "x", delivered: 1, recipients: 1 };
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const output = new PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		try {
			await withBridgeEnvironment(config.env, () =>
				handleClaudeMcpLine(
					JSON.stringify({
						jsonrpc: "2.0",
						id: null,
						method: "tools/call",
						params: { name: "send_file", arguments: { path: "f" } },
					}),
					output,
				),
			);
		} finally {
			vi.unstubAllGlobals();
			await instance.shutdown();
		}
		expect(JSON.parse(response)).toMatchObject({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Invalid Request" },
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(delivered).toBe(0);
	});

	it("returns fixed parse errors for malformed and oversized frames", async () => {
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
});
