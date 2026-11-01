export function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("baseUrl must be a loopback HTTP URL");
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new TypeError(
			"baseUrl must be http://127.0.0.1:<port> without credentials, path, query, or fragment",
		);
	}
	return url.origin;
}
