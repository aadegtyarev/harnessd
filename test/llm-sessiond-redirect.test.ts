import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
	LlmSessiondClient,
	LlmSessiondTransportError,
} from "../src/llm-sessiond/index.js";

const servers: ReturnType<typeof createServer>[] = [];
async function listen(server: ReturnType<typeof createServer>) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	const active = servers.splice(0);
	for (const server of active) server.closeAllConnections();
	await Promise.all(
		active.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
});

it("rejects cross-authority GET redirects and POST 307/308 without replay", async () => {
	const targetBodies: string[] = [];
	const target = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		targetBodies.push(body);
		res.end("{}");
	});
	const targetUrl = await listen(target);
	for (const status of [302, 307, 308]) {
		let localCalls = 0;
		const redirect = createServer((_, res) => {
			localCalls++;
			res.writeHead(status, { location: `${targetUrl}/stolen` });
			res.end();
		});
		const baseUrl = await listen(redirect);
		const client = new LlmSessiondClient({ baseUrl });
		const action =
			status === 302
				? client.health()
				: client.submitInput("session", {
						text: "do not forward",
						images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
					});
		await expect(action).rejects.toBeInstanceOf(LlmSessiondTransportError);
		expect(localCalls).toBe(1);
		expect(targetBodies).toEqual([]);
	}
});
