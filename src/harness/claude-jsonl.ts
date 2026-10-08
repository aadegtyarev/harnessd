export const MAX_CLAUDE_RECORD_BYTES = 1024 * 1024;

export function parseClaudeRecord(line: string): Record<string, unknown> {
	if (Buffer.byteLength(line, "utf8") > MAX_CLAUDE_RECORD_BYTES)
		throw new Error("CLAUDE_RECORD_TOO_LARGE");
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("CLAUDE_INVALID_JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("CLAUDE_INVALID_RECORD");
	return value as Record<string, unknown>;
}

export class ClaudeJsonlFramer {
	private pending = Buffer.alloc(0);
	constructor(private readonly onRecord: (record: string) => void) {}
	push(chunk: Buffer): void {
		this.pending = Buffer.concat([this.pending, chunk]);
		if (
			this.pending.length > MAX_CLAUDE_RECORD_BYTES &&
			!this.pending.includes(10)
		)
			throw new Error("CLAUDE_RECORD_TOO_LARGE");
		for (;;) {
			const newline = this.pending.indexOf(10);
			if (newline < 0) break;
			let line = this.pending.subarray(0, newline);
			this.pending = this.pending.subarray(newline + 1);
			if (line.at(-1) === 13) line = line.subarray(0, -1);
			if (line.length > MAX_CLAUDE_RECORD_BYTES)
				throw new Error("CLAUDE_RECORD_TOO_LARGE");
			if (line.length)
				this.onRecord(new TextDecoder("utf-8", { fatal: true }).decode(line));
		}
	}
	finish(): void {
		if (this.pending.length) throw new Error("CLAUDE_TRUNCATED_RECORD");
	}
}
