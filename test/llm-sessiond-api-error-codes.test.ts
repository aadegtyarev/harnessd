import { expect, it } from "vitest";
import {
	type LlmSessiondApiError,
	LlmSessiondClient,
} from "../src/llm-sessiond/index.js";

const cases = [
	[400, "INVALID_CWD"],
	[400, "INVALID_JSON"],
	[400, "INVALID_PATH"],
	[400, "VALIDATION_ERROR"],
	[404, "NOT_FOUND"],
	[409, "CANCEL_FAILED"],
	[409, "INPUT_BUSY"],
	[409, "INPUT_NOT_CURRENT"],
	[409, "INPUT_UNCERTAIN"],
	[409, "RESUME_FAILED"],
	[409, "SESSION_NOT_RESUMABLE"],
	[409, "SESSION_NOT_RUNNING"],
	[413, "LIMIT_EXCEEDED"],
	[500, "INPUT_FAILED"],
	[500, "INTERNAL_ERROR"],
] as const;

it("maps every normative HTTP status/API code pair", async () => {
	for (const [status, code] of cases) {
		const fetcher: typeof fetch = async () =>
			new Response(JSON.stringify({ error: { code, message: "safe" } }), {
				status,
			});
		await expect(
			new LlmSessiondClient({
				baseUrl: "http://127.0.0.1:1234",
				fetch: fetcher,
			}).health(),
		).rejects.toMatchObject({
			status,
			code,
			safeMessage: "safe",
		} satisfies Partial<LlmSessiondApiError>);
	}
});
