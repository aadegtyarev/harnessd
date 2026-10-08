import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";
import { forwardClaudeSendFile } from "../src/harness/claude-send-file-forward.js";

afterEach(() => vi.unstubAllGlobals());

describe("Claude send_file forwarding timeout", () => {
	it("bounds one forwarding attempt and returns uncertain without retry", async () => {
		const oldUrl = process.env[AGENT_FILE_SEND_URL_ENV];
		const oldToken = process.env[AGENT_FILE_SEND_TOKEN_ENV];
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
			if (oldUrl === undefined) delete process.env[AGENT_FILE_SEND_URL_ENV];
			else process.env[AGENT_FILE_SEND_URL_ENV] = oldUrl;
			if (oldToken === undefined) delete process.env[AGENT_FILE_SEND_TOKEN_ENV];
			else process.env[AGENT_FILE_SEND_TOKEN_ENV] = oldToken;
		}
	});
});
