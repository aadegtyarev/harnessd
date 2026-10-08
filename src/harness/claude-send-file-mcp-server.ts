import { fileURLToPath } from "node:url";
import { handleClaudeMcpLine } from "./claude-send-file-mcp.js";

const MAX_LINE_BYTES = 16 * 1024;

export function startClaudeSendFileMcpServer(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): void {
	let pending = Buffer.alloc(0);
	let discardingOversizedLine = false;
	input.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		let newline = pending.indexOf(0x0a);
		while (newline >= 0) {
			const line = pending.subarray(0, newline);
			pending = pending.subarray(newline + 1);
			if (discardingOversizedLine) {
				discardingOversizedLine = false;
			} else if (line.length <= MAX_LINE_BYTES) {
				void handleClaudeMcpLine(line.toString("utf8"), output);
			} else {
				writeParseError(output);
			}
			newline = pending.indexOf(0x0a);
		}
		if (pending.length > MAX_LINE_BYTES) {
			pending = Buffer.alloc(0);
			discardingOversizedLine = true;
			writeParseError(output);
		}
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	startClaudeSendFileMcpServer();

function writeParseError(output: NodeJS.WritableStream): void {
	output.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
	);
}
