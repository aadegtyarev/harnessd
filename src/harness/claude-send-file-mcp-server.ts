import { fileURLToPath } from "node:url";
import {
	handleClaudeMcpLine,
	writeClaudeMcpParseError,
} from "./claude-send-file-mcp.js";

const MAX_LINE_BYTES = 16 * 1024;
const MAX_QUEUED_FRAMES = 8;
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * (MAX_QUEUED_FRAMES + 1);
const PARSE_ERROR = "\u0000";
type LineHandler = typeof handleClaudeMcpLine;

export function startClaudeSendFileMcpServer(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
	handleLine: LineHandler = handleClaudeMcpLine,
): { stop(): void } {
	let pending = Buffer.alloc(0);
	let discardingOversizedLine = false;
	let stopped = false;
	let running = false;
	const queue: string[] = [];
	const shutdown = new AbortController();
	const stop = () => {
		if (stopped) return;
		stopped = true;
		queue.length = 0;
		pending = Buffer.alloc(0);
		shutdown.abort();
		input.pause();
		(input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
	};
	const enqueueFrames = () => {
		let newline = pending.indexOf(0x0a);
		while (!stopped && queue.length < MAX_QUEUED_FRAMES && newline >= 0) {
			const line = pending.subarray(0, newline);
			pending = pending.subarray(newline + 1);
			if (discardingOversizedLine) discardingOversizedLine = false;
			else
				queue.push(
					line.length <= MAX_LINE_BYTES ? line.toString("utf8") : PARSE_ERROR,
				);
			newline = pending.indexOf(0x0a);
		}
		if (
			!discardingOversizedLine &&
			queue.length < MAX_QUEUED_FRAMES &&
			pending.length > MAX_LINE_BYTES
		) {
			pending = Buffer.alloc(0);
			discardingOversizedLine = true;
			queue.push(PARSE_ERROR);
		}
		if (pending.length > MAX_BUFFER_BYTES) stop();
		if (queue.length >= MAX_QUEUED_FRAMES) input.pause();
		void dispatch();
	};
	const dispatch = async () => {
		if (running || stopped) return;
		running = true;
		try {
			while (queue.length > 0 && !stopped) {
				const frame = queue.shift();
				if (frame === PARSE_ERROR)
					await writeClaudeMcpParseError(output, shutdown.signal);
				else if (frame !== undefined)
					await handleLine(frame, output, shutdown.signal);
				enqueueFrames();
			}
		} catch {
			stop();
		} finally {
			running = false;
			if (!stopped && queue.length < MAX_QUEUED_FRAMES) input.resume();
		}
	};
	input.on("data", (chunk: Buffer) => {
		if (pending.length + chunk.length > MAX_BUFFER_BYTES) {
			stop();
			return;
		}
		pending = Buffer.concat([pending, chunk]);
		enqueueFrames();
	});
	input.once("end", stop);
	input.once("close", stop);
	return { stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const server = startClaudeSendFileMcpServer();
	process.once("SIGTERM", server.stop);
	process.once("SIGINT", server.stop);
}
