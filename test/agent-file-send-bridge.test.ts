import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "../src/core/types.js";
import { startAgentFileSendBridge } from "../src/harness/agent-file-send-bridge.js";
import {
	AGENT_FILE_SEND_TOKEN_ENV,
	AGENT_FILE_SEND_URL_ENV,
} from "../src/harness/agent-file-send-protocol.js";

const bridges: Awaited<ReturnType<typeof startAgentFileSendBridge>>[] = [];
afterEach(async () => {
	await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("agent file-send bridge", () => {
	it("validates requests and forwards only the session-scoped file request", async () => {
		const send = vi.fn(async () => ({
			fileName: "notes.txt",
			delivered: 1,
			recipients: 1,
		}));
		const bridge = await startAgentFileSendBridge("sid" as SessionId, send);
		bridges.push(bridge);
		const response = await fetch(bridge.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bridge.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ path: "report.txt", caption: "Here it is" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			result: { fileName: "notes.txt", delivered: 1, recipients: 1 },
		});
		expect(send).toHaveBeenCalledWith({
			sessionId: "sid",
			path: "report.txt",
			caption: "Here it is",
		});
	});

	it("rejects unauthenticated and malformed requests without calling the sender", async () => {
		const send = vi.fn(async () => ({
			fileName: "notes.txt",
			delivered: 1,
			recipients: 1,
		}));
		const bridge = await startAgentFileSendBridge("sid" as SessionId, send);
		bridges.push(bridge);
		const unauthenticated = await fetch(bridge.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "report.txt" }),
		});
		expect(unauthenticated.status).toBe(401);
		const malformed = await fetch(bridge.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bridge.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ path: "../outside.txt", extra: true }),
		});
		expect(malformed.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});

	it("passes a fresh bridge only through the dedicated child environment variables", async () => {
		const bridge = await startAgentFileSendBridge(
			"sid" as SessionId,
			async () => ({
				fileName: "a.txt",
				delivered: 0,
				recipients: 1,
			}),
		);
		bridges.push(bridge);
		expect(AGENT_FILE_SEND_URL_ENV).toBe("HARNESSD_AGENT_FILE_SEND_URL");
		expect(AGENT_FILE_SEND_TOKEN_ENV).toBe("HARNESSD_AGENT_FILE_SEND_TOKEN");
		expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
		expect(bridge.token).toMatch(/^[a-f0-9]{64}$/);
	});
});
