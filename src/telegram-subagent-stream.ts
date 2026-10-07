import {
	closesFence,
	fenceDelimiter,
	isPotential,
	mightBeFence,
} from "./telegram-subagent-framing.js";
import {
	MAX_SUBAGENT_ENVELOPE_CHARS,
	parseSubagentWidgetLine,
} from "./telegram-subagent-status.js";

export type SubagentTextResult = {
	readonly visibleText: string;
	readonly statuses: readonly string[];
};

export function parseNotificationText(text: string): SubagentTextResult {
	return new SubagentTextStream().consume(text, true);
}

export class SubagentTextStream {
	private pending = "";
	private fenced = false;
	private fenceChar = "";
	private fenceLength = 0;
	private discarding = false;

	consume(chunk: string, final = false): SubagentTextResult {
		let visibleText = "";
		const statuses: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			if (this.discarding) {
				const newline = chunk.indexOf("\n", cursor);
				if (newline < 0) return { visibleText, statuses };
				this.discarding = false;
				cursor = newline + 1;
				continue;
			}
			const newline = chunk.indexOf("\n", cursor);
			const end = newline < 0 ? chunk.length : newline;
			const segment = chunk.slice(cursor, end);
			if (
				this.pending.length + segment.length > MAX_SUBAGENT_ENVELOPE_CHARS &&
				isPotential(`${this.pending}${segment.slice(0, 128)}`)
			) {
				this.pending = "";
				if (newline < 0) this.discarding = true;
				else cursor = newline + 1;
				continue;
			}
			this.pending += segment;
			if (newline >= 0) {
				cursor = newline + 1;
				visibleText += this.finishLine(this.pending, statuses);
				this.pending = "";
				continue;
			}
			if (this.fenced) {
				if (mightBeFence(this.pending)) break;
				visibleText += this.pending;
				this.pending = "";
			} else if (isPotential(this.pending) || mightBeFence(this.pending)) {
				const parsed = parseSubagentWidgetLine(this.pending);
				if (parsed.status) statuses.push(parsed.status);
			} else {
				visibleText += this.pending;
				this.pending = "";
			}
			break;
		}
		if (final && this.pending) {
			if (!this.fenced)
				visibleText += this.finishLine(this.pending, statuses, false);
			else visibleText += this.pending;
			this.pending = "";
		}
		return { visibleText, statuses };
	}

	private finishLine(line: string, statuses: string[], newline = true): string {
		if (this.fenced) {
			if (closesFence(line, this.fenceChar, this.fenceLength))
				this.fenced = false;
			return line + (newline ? "\n" : "");
		}
		const fence = fenceDelimiter(line);
		if (fence) {
			this.fenced = true;
			this.fenceChar = fence.char;
			this.fenceLength = fence.length;
			return line + (newline ? "\n" : "");
		}
		const parsed = parseSubagentWidgetLine(line);
		if (parsed.status) statuses.push(parsed.status);
		return parsed.matched ? "" : line + (newline ? "\n" : "");
	}
}
