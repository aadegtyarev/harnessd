import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { LlmSessiondClient } from "../src/llm-sessiond/index.js";

const servers: ReturnType<typeof createServer>[] = [];
const session = {
	id: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
	harnessId: "pi",
	cwd: "/tmp",
	status: "running",
};
it("calls every HTTP v1 route with canonical method, body, and status", async () => {
	const seen: [string, string, string][] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		seen.push([req.url ?? "", req.method ?? "", body]);
		const [status, payload] = req.url?.endsWith("/health")
			? [200, { apiVersion: "v1", status: "ready", version: "1" }]
			: req.url?.endsWith("/harnesses")
				? [200, { harnesses: [] }]
				: req.url === "/api/v1/sessions" && req.method === "GET"
					? [200, { sessions: [session] }]
					: req.url === "/api/v1/sessions"
						? [201, { session }]
						: req.url?.endsWith("/inputs")
							? [202, { inputId: "d86ce5ad-e311-4a9b-8e4e-1734e5b6b10e" }]
							: req.url?.includes("/cancel") ||
									req.url?.endsWith("/stop") ||
									req.url?.endsWith("/resume")
								? [204, null]
								: [200, { session }];
		res.statusCode = status;
		if (status === 204) res.end();
		else res.end(JSON.stringify(payload));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	const client = new LlmSessiondClient({
		baseUrl: `http://127.0.0.1:${address.port}`,
	});
	await client.health();
	await client.harnesses();
	await client.listSessions();
	await client.getSession(session.id);
	await client.createSession({ harnessId: "pi", cwd: "/tmp", name: "x" });
	const inputId = (await client.submitInput(session.id, { text: "prompt" }))
		.inputId;
	await client.cancelInput(session.id, inputId);
	await client.stopSession(session.id);
	await client.resumeSession(session.id);
	expect(seen.map(([url, method]) => [url, method])).toEqual([
		["/api/v1/health", "GET"],
		["/api/v1/harnesses", "GET"],
		["/api/v1/sessions", "GET"],
		[`/api/v1/sessions/${session.id}`, "GET"],
		["/api/v1/sessions", "POST"],
		[`/api/v1/sessions/${session.id}/inputs`, "POST"],
		[`/api/v1/sessions/${session.id}/cancel`, "POST"],
		[`/api/v1/sessions/${session.id}/stop`, "POST"],
		[`/api/v1/sessions/${session.id}/resume`, "POST"],
	]);
	expect(seen[4]?.[2]).toContain('"name":"x"');
	expect(seen[6]?.[2]).toBe(JSON.stringify({ inputId }));
	expect(seen[5]?.[2]).toContain("prompt");
	expect(seen[7]?.[2]).toBe("{}");
	expect(seen[8]?.[2]).toBe("{}");
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});
