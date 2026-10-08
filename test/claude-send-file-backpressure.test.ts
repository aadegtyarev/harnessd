import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { startClaudeSendFileMcpServer } from "../src/harness/claude-send-file-mcp-server.js";

describe("Claude MCP stdin/stdout backpressure", () => {
	it("caps queued requests and cancels hung in-flight work at shutdown", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let calls = 0;
		const server = startClaudeSendFileMcpServer(
			input,
			output,
			async (_line, _out, signal) => {
				calls += 1;
				if (!signal) throw new Error("Missing shutdown signal");
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		);
		const request = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		input.write(`${Array.from({ length: 40 }, () => request).join("\n")}\n`);
		await new Promise((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
		expect(input.isPaused()).toBe(true);
		server.stop();
		await new Promise((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
	});

	it("waits for blocked stdout drain and aborts the wait on shutdown", async () => {
		const input = new PassThrough();
		let finishWrite: (() => void) | undefined;
		let writes = 0;
		const output = new Writable({
			highWaterMark: 1,
			write(_chunk, _encoding, callback) {
				writes += 1;
				finishWrite = callback;
			},
		});
		const server = startClaudeSendFileMcpServer(input, output);
		input.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(writes).toBe(1);
		server.stop();
		await new Promise((resolve) => setImmediate(resolve));
		finishWrite?.();
		expect(writes).toBe(1);
	});
});
