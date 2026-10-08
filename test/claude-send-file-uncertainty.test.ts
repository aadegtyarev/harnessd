import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";
import { forwardClaudeSendFile } from "../src/harness/claude-send-file-forward.js";
import {
	callTool,
	captureOutput,
	launchFileHandler,
	withBridgeEnvironment,
} from "./claude-send-file-test-fixture.js";

describe("Claude send_file uncertain delivery", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("times out one forwarding attempt without retry", async () => {
		const previousUrl = process.env[AGENT_FILE_SEND_URL_ENV];
		const previousToken = process.env[AGENT_FILE_SEND_TOKEN_ENV];
		process.env[AGENT_FILE_SEND_URL_ENV] = "http://127.0.0.1:1/send-file";
		process.env[AGENT_FILE_SEND_TOKEN_ENV] = "test-token";
		const fetchMock = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await forwardClaudeSendFile(
				{ name: "send_file", arguments: { path: "f" } },
				new AbortController().signal,
				5,
			);
			expect(result).toMatchObject({
				isError: true,
				content: [{ text: "File delivery may be uncertain; do not retry." }],
			});
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			if (previousUrl === undefined)
				delete process.env[AGENT_FILE_SEND_URL_ENV];
			else process.env[AGENT_FILE_SEND_URL_ENV] = previousUrl;
			if (previousToken === undefined)
				delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
			else process.env[AGENT_FILE_SEND_TOKEN_ENV] = previousToken;
		}
	});
	it("warns after handler rejection following a possible side effect", async () => {
		let calls = 0;
		const { instance, config } = await launchFileHandler(async () => {
			calls += 1;
			throw new Error("after possible delivery");
		});
		const output = captureOutput();
		await withBridgeEnvironment(config.env, () =>
			callTool(output.stream, 1, { path: "f" }),
		);
		await instance.shutdown();
		expect(calls).toBe(1);
		expect(output.text()).toContain(
			"File delivery may be uncertain; do not retry.",
		);
	});

	it("treats malformed bridge success as uncertain without retry", async () => {
		let calls = 0;
		const { instance, config } = await launchFileHandler(async () => {
			calls += 1;
			return {} as { fileName: string; delivered: number; recipients: number };
		});
		const output = captureOutput();
		await withBridgeEnvironment(config.env, () =>
			callTool(output.stream, 2, { path: "f" }),
		);
		await instance.shutdown();
		expect(calls).toBe(1);
		expect(output.text()).toContain(
			"File delivery may be uncertain; do not retry.",
		);
	});
});
