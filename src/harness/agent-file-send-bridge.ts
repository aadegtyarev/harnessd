import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AgentFileSendHandler,
	AgentFileSendResult,
} from "../core/ports.js";
import type { SessionId } from "../core/types.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;

export interface AgentFileSendBridge {
	readonly url: string;
	readonly token: string;
	close(): Promise<void>;
}

export async function startAgentFileSendBridge(
	sessionId: SessionId,
	handler: AgentFileSendHandler,
): Promise<AgentFileSendBridge> {
	const token = randomBytes(32).toString("hex");
	const server = createServer((request, response) => {
		void handleRequest(request, response, token, sessionId, handler);
	});
	server.maxConnections = 4;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo | null;
	if (!address || typeof address === "string") {
		await closeServer(server);
		throw new Error("Agent file-send bridge failed to bind");
	}
	let closed = false;
	return {
		url: `http://127.0.0.1:${address.port}/send-file`,
		token,
		async close() {
			if (closed) return;
			closed = true;
			await closeServer(server);
		},
	};
}

async function handleRequest(
	request: import("node:http").IncomingMessage,
	response: import("node:http").ServerResponse,
	token: string,
	sessionId: SessionId,
	handler: AgentFileSendHandler,
): Promise<void> {
	if (request.method !== "POST" || request.url !== "/send-file") {
		respond(response, 404, { ok: false, error: "Not found" });
		return;
	}
	if (!authorized(request.headers.authorization, token)) {
		respond(response, 401, { ok: false, error: "Unauthorized" });
		return;
	}
	if (!request.headers["content-type"]?.startsWith("application/json")) {
		respond(response, 415, { ok: false, error: "Unsupported content type" });
		return;
	}
	try {
		const body = await readBody(request);
		const decoded: unknown = JSON.parse(body);
		const input = validateInput(decoded);
		if (!input) {
			respond(response, 400, { ok: false, error: "Invalid file request" });
			return;
		}
		const result = await handler({ sessionId, ...input });
		respond(response, 200, { ok: true, result });
	} catch {
		respond(response, 200, { ok: false, error: "File could not be sent" });
	}
}

function authorized(value: string | undefined, token: string): boolean {
	if (!value?.startsWith("Bearer ")) return false;
	const provided = Buffer.from(value.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return (
		provided.length === expected.length && timingSafeEqual(provided, expected)
	);
}

async function readBody(
	request: import("node:http").IncomingMessage,
): Promise<string> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += data.length;
		if (length > MAX_REQUEST_BYTES) throw new Error("Request too large");
		chunks.push(data);
	}
	return Buffer.concat(chunks, length).toString("utf8");
}

function validateInput(
	value: unknown,
): { readonly path: string; readonly caption?: string } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => key !== "path" && key !== "caption") ||
		typeof record.path !== "string" ||
		record.path.length === 0 ||
		record.path.length > MAX_PATH_LENGTH ||
		record.path.includes("\0")
	)
		return undefined;
	if (record.caption !== undefined) {
		if (
			typeof record.caption !== "string" ||
			[...record.caption].length > MAX_CAPTION_LENGTH
		)
			return undefined;
		return { path: record.path, caption: record.caption };
	}
	return { path: record.path };
}

function respond(
	response: import("node:http").ServerResponse,
	status: number,
	body: {
		readonly ok: boolean;
		readonly error?: string;
		readonly result?: AgentFileSendResult;
	},
): void {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		connection: "close",
	});
	response.end(JSON.stringify(body));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}
