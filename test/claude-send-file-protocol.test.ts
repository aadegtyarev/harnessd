import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleClaudeMcpLine } from "../src/harness/claude-send-file-mcp.js";
import { startClaudeSendFileMcpServer } from "../src/harness/claude-send-file-mcp-server.js";

describe("Claude MCP JSON-RPC frames", () => {
	it("echoes string/integer IDs and rejects invalid IDs and envelopes", async () => {
		const output = new PassThrough();
		let response = "";
		output.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		for (const id of ["client-request", 7, null])
			await handleClaudeMcpLine(
				JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
				output,
			);
		for (const request of [
			{ jsonrpc: "2.0", id: {}, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1.5, method: "tools/list" },
			{ jsonrpc: "1.0", id: 9, method: "tools/list" },
			{ jsonrpc: "2.0", id: true, method: "tools/list" },
			{ jsonrpc: "2.0", id: 10, method: "tools/list", params: [] },
			{ jsonrpc: "2.0", id: 11, method: "" },
		])
			await handleClaudeMcpLine(JSON.stringify(request), output);
		const replies = response
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: unknown; error?: unknown });
		expect(replies.slice(0, 3).map((reply) => reply.id)).toEqual([
			"client-request",
			7,
			null,
		]);
		expect(replies.slice(3).map((reply) => reply.error)).toEqual(
			Array(6).fill({ code: -32600, message: "Invalid Request" }),
		);
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
