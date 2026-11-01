import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { LlmSessiondClient } from "../src/llm-sessiond/index.js";

const servers: ReturnType<typeof createServer>[] = [];
async function bodyServer(status: number, destroy = false) {
	const server = createServer((_, res) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.write("{");
		if (destroy) setTimeout(() => res.destroy(), 5);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	return { url: `http://127.0.0.1:${address.port}`, server };
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

it("classifies real body timeout as transport for success and API-error statuses", async () => {
	for (const [status, method] of [
		[200, "health"],
		[409, "submit"],
	] as const) {
		const fixture = await bodyServer(status);
		const client = new LlmSessiondClient({
			baseUrl: fixture.url,
			timeoutMs: 35,
		});
		const request =
			method === "health"
				? client.health()
				: client.submitInput("id", { text: "secret" });
		await expect(request).rejects.toMatchObject({ kind: "timeout" });
	}
});

it("classifies an aborted response body as network transport failure", async () => {
	const fixture = await bodyServer(200, true);
	await expect(
		new LlmSessiondClient({ baseUrl: fixture.url, timeoutMs: 1000 }).health(),
	).rejects.toMatchObject({ kind: "network" });
});
