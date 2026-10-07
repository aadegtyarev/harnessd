import {
	finishPhysicalLine,
	type PhysicalLineState,
} from "./telegram-subagent-framing.js";
import { OversizedLineClassifier } from "./telegram-subagent-overflow.js";
import { isPotentialParts } from "./telegram-subagent-prefix.js";
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
	private readonly oversized = new OversizedLineClassifier();

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
			const classified = this.oversized.classify(
				this.line,
				segment,
				newline >= 0,
				this.framing.fenced,
			);
			if (classified) {
				if (classified.kind === "pending") {
					this.line = classified.line ?? "";
					break;
				}
				this.line = "";
				if (classified.kind === "discard") {
					this.framing.statusReported = false;
					if (newline < 0) this.discarding = true;
					else cursor = newline + 1;
					continue;
				}
				visibleText += classified.text ?? "";
				overflow ||= classified.overflow ?? false;
				if (classified.continuation) {
					this.continuation = true;
					break;
				}
				cursor = newline + 1;
				continue;
			}
			const tooLong =
				this.line.length + segment.length > MAX_SUBAGENT_ENVELOPE_CHARS;
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
			const resolved = this.oversized.finish(this.line);
			if (resolved) {
				visibleText += resolved.text ?? "";
				overflow ||= resolved.overflow ?? false;
				this.line = "";
			}
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
		return { visibleText, statuses, overflow };
	}
}
