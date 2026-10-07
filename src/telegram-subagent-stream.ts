import {
	finishPhysicalLine,
	type PhysicalLineState,
	reportPartialSubagentStatus,
} from "./telegram-subagent-framing.js";
import { OversizedLineClassifier } from "./telegram-subagent-overflow.js";
import { finalizeSubagentStream } from "./telegram-subagent-stream-finalize.js";
import type { SubagentTextResult } from "./telegram-subagent-stream-result.js";

export type { SubagentTextResult } from "./telegram-subagent-stream-result.js";

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
			this.line += segment;
			if (newline >= 0) {
				visibleText += finishPhysicalLine(this.line, this.framing, statuses);
				this.line = "";
				this.framing.statusReported = false;
				cursor = newline + 1;
				continue;
			}
			reportPartialSubagentStatus(this.line, this.framing, statuses);
			break;
		}
		if (final) {
			const resolved = finalizeSubagentStream(
				this.line,
				this.framing,
				this.oversized,
				statuses,
			);
			visibleText += resolved.visibleText;
			overflow ||= resolved.overflow;
			this.line = "";
			this.discarding = false;
			this.framing.statusReported = false;
			this.continuation = false;
		}
		return { visibleText, statuses, overflow };
	}
}
