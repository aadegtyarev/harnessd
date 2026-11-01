import { normalizeBaseUrl } from "./base-url.js";
import { type ClientOptions, requestJson } from "./http.js";

export class LlmSessiondHttpOperations {
	protected readonly baseUrl: string;
	protected readonly timeoutMs: number;
	private readonly fetcher: typeof fetch;

	constructor(options: ClientOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.fetcher = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
			throw new RangeError("timeoutMs must be a positive finite number");
	}

	protected get<T>(
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
	protected post<T>(
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
	protected postVoid(path: string, body: unknown): Promise<void> {
		return this.post<void>(path, body, 204);
	}
}
