import {
	finishPhysicalLine,
	isPotentialParts,
	isWhitespaceParts,
	type PhysicalLineState,
} from "./telegram-subagent-framing.js";
import {
	MAX_SUBAGENT_ENVELOPE_CHARS,
	parseSubagentWidgetLine,
} from "./telegram-subagent-status.js";

export type SubagentTextResult = {
	readonly visibleText: string;
	readonly statuses: readonly string[];
	readonly overflow: boolean;
};

export class SubagentTextStream {
	private line = "";
	private readonly framing: PhysicalLineState = {
		fenced: false,
		fenceChar: "",
		fenceLength: 0,
		statusReported: false,
	};
	private discarding = false;
	private continuation = false;
	private leadingWhitespaceOverflow = false;

	consume(chunk: string, final = false): SubagentTextResult {
		let visibleText = "";
		let overflow = false;
		const statuses: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			const newline = chunk.indexOf("\n", cursor);
			const end = newline < 0 ? chunk.length : newline;
			const segment = chunk.slice(cursor, end);
			if (this.discarding) {
				if (newline < 0) break;
				this.discarding = false;
				cursor = newline + 1;
				continue;
			}
			if (this.continuation) {
				visibleText += segment + (newline < 0 ? "" : "\n");
				if (newline < 0) break;
				this.continuation = false;
				cursor = newline + 1;
				continue;
			}
			const tooLong =
				this.line.length + segment.length > MAX_SUBAGENT_ENVELOPE_CHARS;
			if (
				tooLong &&
				!this.framing.fenced &&
				isPotentialParts(this.line, segment)
			) {
				this.line = "";
				this.framing.statusReported = false;
				this.leadingWhitespaceOverflow = false;
				if (newline < 0) this.discarding = true;
				else cursor = newline + 1;
				continue;
			}
			if (
				tooLong &&
				!this.framing.fenced &&
				isWhitespaceParts(this.line, segment)
			) {
				this.line += segment.slice(
					0,
					MAX_SUBAGENT_ENVELOPE_CHARS - this.line.length,
				);
				this.leadingWhitespaceOverflow = true;
				if (newline >= 0) {
					overflow = true;
					visibleText += finishPhysicalLine(this.line, this.framing, statuses);
					this.line = "";
					this.framing.statusReported = false;
					cursor = newline + 1;
					continue;
				}
				break;
			}
			if (tooLong) {
				overflow ||= this.leadingWhitespaceOverflow;
				this.leadingWhitespaceOverflow = false;
				visibleText += this.line + segment + (newline < 0 ? "" : "\n");
				this.line = "";
				if (newline < 0) this.continuation = true;
				else cursor = newline + 1;
				continue;
			}
			this.line += segment;
			if (newline >= 0) {
				overflow ||= this.leadingWhitespaceOverflow;
				this.leadingWhitespaceOverflow = false;
				visibleText += finishPhysicalLine(this.line, this.framing, statuses);
				this.line = "";
				this.framing.statusReported = false;
				cursor = newline + 1;
				continue;
			}
			if (!this.framing.fenced && isPotentialParts(this.line, "")) {
				const parsed = parseSubagentWidgetLine(this.line);
				if (parsed.status && !this.framing.statusReported) {
					statuses.push(parsed.status);
					this.framing.statusReported = true;
				}
			}
			break;
		}
		if (final) {
			if (this.line) {
				overflow ||= this.leadingWhitespaceOverflow;
				this.leadingWhitespaceOverflow = false;
				visibleText += this.framing.fenced
					? this.line
					: finishPhysicalLine(this.line, this.framing, statuses, false);
				this.line = "";
			}
			this.discarding = false;
			this.framing.statusReported = false;
			this.continuation = false;
			this.leadingWhitespaceOverflow = false;
		}
		return { visibleText, statuses, overflow };
	}
}
