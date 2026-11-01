import { describe, expect, it } from "vitest";
import {
	LlmSessiondApiError,
	LlmSessiondClient,
	LlmSessiondTransportError,
} from "../src/llm-sessiond/index.js";

const baseUrl = "http://127.0.0.1:12345";
describe("LlmSessiondClient safe non-retry failures", () => {
	it("preserves INPUT_UNCERTAIN without replaying input", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			return new Response(
				JSON.stringify({
					error: { code: "INPUT_UNCERTAIN", message: "delivery uncertain" },
				}),
				{ status: 409 },
			);
		};
		const client = new LlmSessiondClient({ baseUrl, fetch: fetcher });
		await expect(
			client.submitInput("session", { text: "secret prompt" }),
		).rejects.toMatchObject({ code: "INPUT_UNCERTAIN", status: 409 });
		expect(calls).toBe(1);
	});

	it("maps remaining API error status/code pairs explicitly", async () => {
		for (const [status, code] of [
			[400, "VALIDATION_ERROR"],
			[413, "LIMIT_EXCEEDED"],
		] as const) {
			const fetcher: typeof fetch = async () =>
				new Response(JSON.stringify({ error: { code, message: "safe" } }), {
					status,
				});
			await expect(
				new LlmSessiondClient({ baseUrl, fetch: fetcher }).health(),
			).rejects.toMatchObject({ status, code });
		}
	});

	it("classifies malformed JSON and timeouts without exposing details", async () => {
		const malformed: typeof fetch = async () =>
			new Response("private prompt", { status: 200 });
		await expect(
			new LlmSessiondClient({ baseUrl, fetch: malformed }).health(),
		).rejects.toMatchObject({ kind: "json" });
		const timeout = Object.assign(new Error("private timeout details"), {
			name: "TimeoutError",
		});
		const timed: typeof fetch = async () => {
			throw timeout;
		};
		await expect(
			new LlmSessiondClient({ baseUrl, fetch: timed }).health(),
		).rejects.toMatchObject({
			kind: "timeout",
			message: "llm-sessiond transport error: request timed out",
		});
	});

	it("hides network exception details and performs one attempt", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			throw new Error("private response and prompt");
		};
		const client = new LlmSessiondClient({ baseUrl, fetch: fetcher });
		const request = client.submitInput("session", { text: "private prompt" });
		await expect(request).rejects.toBeInstanceOf(LlmSessiondTransportError);
		expect(calls).toBe(1);
		await expect(request).rejects.not.toThrow("private");
		expect(
			new LlmSessiondApiError(409, "INPUT_UNCERTAIN", "safe").message,
		).not.toContain("prompt");
	});
});
