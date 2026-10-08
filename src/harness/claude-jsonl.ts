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
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			if (newline < 0) {
				this.append(chunk.subarray(offset));
				return;
			}
			const segment = chunk.subarray(offset, newline);
			const line = this.pending.length
				? Buffer.concat([this.pending, segment])
				: segment;
			this.pending = Buffer.alloc(0);
			if (line.length > MAX_CLAUDE_RECORD_BYTES)
				throw new Error("CLAUDE_RECORD_TOO_LARGE");
			this.record(line);
			offset = newline + 1;
		}
	}
	private append(segment: Buffer): void {
		if (this.pending.length + segment.length > MAX_CLAUDE_RECORD_BYTES)
			throw new Error("CLAUDE_RECORD_TOO_LARGE");
		this.pending = Buffer.concat([this.pending, segment]);
	}
	private record(bytes: Buffer): void {
		let line = bytes;
		if (line.at(-1) === 13) line = line.subarray(0, -1);
		if (line.length)
			this.onRecord(new TextDecoder("utf-8", { fatal: true }).decode(line));
	}
	finish(): void {
		if (this.pending.length) throw new Error("CLAUDE_TRUNCATED_RECORD");
	}
}
