import { normalizeBaseUrl } from "./base-url.js";
import { type ClientOptions, requestJson } from "./http.js";
import {
	harnessesSchema,
	healthSchema,
	inputResponseSchema,
	sessionResponseSchema,
	sessionsSchema,
} from "./schemas.js";
import type { SessionCreate, SessionInput } from "./types.js";

export class LlmSessiondOperations {
	protected readonly baseUrl: string;
	private readonly fetcher: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: ClientOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.fetcher = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	health() {
		return this.get("/health", healthSchema);
	}
	harnesses() {
		return this.get("/harnesses", harnessesSchema);
	}
	listSessions() {
		return this.get("/sessions", sessionsSchema);
	}
	getSession(id: string) {
		return this.get(
			`/sessions/${encodeURIComponent(id)}`,
			sessionResponseSchema,
		);
	}
	createSession(input: SessionCreate) {
		return this.post("/sessions", input, 201, sessionResponseSchema);
	}
	submitInput(id: string, input: SessionInput) {
		return this.post(
			`/sessions/${encodeURIComponent(id)}/inputs`,
			input,
			202,
			inputResponseSchema,
		);
	}
	cancelInput(id: string, inputId: string) {
		return this.post(
			`/sessions/${encodeURIComponent(id)}/cancel`,
			{ inputId },
			204,
		);
	}
	stopSession(id: string) {
		return this.post(`/sessions/${encodeURIComponent(id)}/stop`, {}, 204);
	}
	resumeSession(id: string) {
		return this.post(`/sessions/${encodeURIComponent(id)}/resume`, {}, 204);
	}

	private get<T>(
		path: string,
		schema: { parse(value: unknown): T },
	): Promise<T> {
		return requestJson(
			this.baseUrl,
			this.fetcher,
			this.timeoutMs,
			path,
			"GET",
			undefined,
			200,
			schema,
		);
	}
	private post<T>(
		path: string,
		body: unknown,
		status: number,
		schema?: { parse(value: unknown): T },
	): Promise<T> {
		return requestJson(
			this.baseUrl,
			this.fetcher,
			this.timeoutMs,
			path,
			"POST",
			body,
			status,
			schema ?? { parse: () => undefined as T },
		);
	}
}
