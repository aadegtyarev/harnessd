import {
	finishPhysicalLine,
	isPotential,
	type PhysicalLineState,
} from "./telegram-subagent-framing.js";
import {
	MAX_SUBAGENT_ENVELOPE_CHARS,
	parseSubagentWidgetLine,
} from "./telegram-subagent-status.js";

export type SubagentTextResult = {
	readonly visibleText: string;
	readonly statuses: readonly string[];
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

	consume(chunk: string, final = false): SubagentTextResult {
		let visibleText = "";
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
				isPotential(`${this.line}${segment.slice(0, 128)}`)
			) {
				this.line = "";
				this.framing.statusReported = false;
				if (newline < 0) this.discarding = true;
				else cursor = newline + 1;
				continue;
			}
			if (tooLong) {
				visibleText += this.line + segment + (newline < 0 ? "" : "\n");
				this.line = "";
				if (newline < 0) this.continuation = true;
				else cursor = newline + 1;
				continue;
			}
			this.line += segment;
			if (newline >= 0) {
				visibleText += finishPhysicalLine(this.line, this.framing, statuses);
				this.line = "";
				this.framing.statusReported = false;
				cursor = newline + 1;
				continue;
			}
			if (!this.framing.fenced && isPotential(this.line)) {
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
				visibleText += this.framing.fenced
					? this.line
					: finishPhysicalLine(this.line, this.framing, statuses, false);
				this.line = "";
			}
			this.discarding = false;
			this.framing.statusReported = false;
			this.continuation = false;
		}
		return { visibleText, statuses };
	}
}
