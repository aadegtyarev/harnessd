import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	LlmSessiondApiError,
	LlmSessiondClient,
	LlmSessiondProtocolError,
} from "../src/llm-sessiond/index.js";

const servers: ReturnType<typeof createServer>[] = [];
const session = {
	id: "8b1a9953-c461-4f90-9b89-8f9a9c9e9b40",
	harnessId: "pi",
	cwd: "/tmp",
	status: "running",
};
async function fixture(
	handler: (url: string, method: string, body: string) => [number, unknown],
) {
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		const [status, payload] = handler(req.url ?? "", req.method ?? "", body);
		res.statusCode = status;
		if (status !== 204) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(payload));
		} else res.end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("fixture failed");
	return { url: `http://127.0.0.1:${address.port}` };
}
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

describe("LlmSessiondClient HTTP", () => {
	it("rejects unknown response fields and validates API status/code pairs safely", async () => {
		const f = await fixture(() => [
			404,
			{ error: { code: "NOT_FOUND", message: "safe" } },
		]);
		await expect(
			new LlmSessiondClient({ baseUrl: f.url }).health(),
		).rejects.toMatchObject({
			status: 404,
			code: "NOT_FOUND",
			safeMessage: "safe",
		});
		const wrong = await fixture(() => [
			200,
			{ apiVersion: "v1", status: "ready", version: "1", surprise: true },
		]);
		await expect(
			new LlmSessiondClient({ baseUrl: wrong.url }).health(),
		).rejects.toBeInstanceOf(LlmSessiondProtocolError);
		const mismatch = await fixture(() => [
			400,
			{ error: { code: "NOT_FOUND", message: "private prompt" } },
		]);
		await expect(
			new LlmSessiondClient({ baseUrl: mismatch.url }).health(),
		).rejects.toBeInstanceOf(LlmSessiondProtocolError);
		expect(new LlmSessiondApiError(400, "X", "safe").message).not.toContain(
			"safe",
		);
	});

	it("does not retry failed operations and restricts endpoint authority", async () => {
		let calls = 0;
		const f = await fixture(() => {
			calls++;
			return [500, { error: { code: "INTERNAL_ERROR", message: "safe" } }];
		});
		await expect(
			new LlmSessiondClient({ baseUrl: f.url }).submitInput(session.id, {
				text: "x",
			}),
		).rejects.toBeInstanceOf(LlmSessiondApiError);
		expect(calls).toBe(1);
		expect(
			() => new LlmSessiondClient({ baseUrl: "http://localhost:1234" }),
		).toThrow(TypeError);
		expect(
			() => new LlmSessiondClient({ baseUrl: "http://127.0.0.1:1234/path" }),
		).toThrow(TypeError);
	});
});
