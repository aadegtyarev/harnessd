import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
	LlmSessiondClient,
	LlmSessiondProtocolError,
} from "../src/llm-sessiond/index.js";

const httpServers: ReturnType<typeof createServer>[] = [];
const sockets: WebSocketServer[] = [];
async function fixture(payload: unknown) {
	const server = createServer();
	const ws = new WebSocketServer({ server, path: "/api/v1/events" });
	ws.on("connection", (socket, request) => {
		expect(request.url).toContain(
			"sessionId=8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
		);
		socket.send(JSON.stringify(payload));
	});
	httpServers.push(server);
	sockets.push(ws);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	return `http://127.0.0.1:${address.port}`;
}
const envelope = {
	apiVersion: "v1",
	eventId: 1,
	sessionId: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
	at: "2026-11-01T00:00:00.000Z",
	type: "assistant.delta",
	data: { text: "hello" },
};
afterEach(async () => {
	await Promise.all(
		sockets
			.splice(0)
			.map(
				(socket) =>
					new Promise<void>((resolve) => socket.close(() => resolve())),
			),
	);
	await Promise.all(
		httpServers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

describe("LlmSessiondClient event subscriptions", () => {
	it("validates and returns raw filtered envelopes and closes cleanly", async () => {
		const baseUrl = await fixture(envelope);
		const sub = new LlmSessiondClient({ baseUrl }).subscribe(
			envelope.sessionId,
		);
		expect(await sub.next()).toEqual({ done: false, value: envelope });
		sub.close();
		await sub.closed;
		expect(await sub.next()).toEqual({ done: true, value: undefined });
	});
	it("fails malformed event envelopes without exposing payloads", async () => {
		const baseUrl = await fixture({
			...envelope,
			data: { text: "secret", unknown: true },
		});
		const sub = new LlmSessiondClient({ baseUrl }).subscribe(
			envelope.sessionId,
		);
		await expect(sub.next()).rejects.toBeInstanceOf(LlmSessiondProtocolError);
		await sub.closed;
	});
});
