import {
	compactPotentialParts,
	isCompleteMarkerParts,
	isPotentialParts,
} from "./telegram-subagent-prefix.js";
import { MAX_SUBAGENT_ENVELOPE_CHARS } from "./telegram-subagent-status.js";
import {
	isWhitespaceParts,
	leadingWhitespacePrefix,
} from "./telegram-subagent-whitespace.js";

export type OversizedLineResult = {
	kind: "pending" | "discard" | "visible";
	line?: string;
	text?: string;
	overflow?: boolean;
	continuation?: boolean;
};

export class OversizedLineClassifier {
	private pending = false;
	private probe = "";

	classify(
		line: string,
		segment: string,
		newline: boolean,
		fenced: boolean,
	): OversizedLineResult | undefined {
		if (
			!this.pending &&
			line.length + segment.length <= MAX_SUBAGENT_ENVELOPE_CHARS
		)
			return;
		if (fenced) return;
		if (isCompleteMarkerParts(this.pending ? this.probe : line, segment)) {
			this.reset();
			return { kind: "discard" };
		}
		if (this.pending) return this.classifyPending(line, segment, newline);
		if (isPotentialParts(line, segment)) {
			this.pending = true;
			this.probe = compactPotentialParts(line, segment);
			line = leadingWhitespacePrefix(
				line,
				segment,
				MAX_SUBAGENT_ENVELOPE_CHARS,
			);
			if (!newline) return { kind: "pending", line };
			return this.visible(`${line}${this.probe}\n`);
		}
		if (isWhitespaceParts(line, segment)) {
			this.pending = true;
			line = leadingWhitespacePrefix(
				line,
				segment,
				MAX_SUBAGENT_ENVELOPE_CHARS,
			);
			if (!newline) return { kind: "pending", line };
			return this.visible(`${line}\n`);
		}
		return this.visible(`${line}${segment}${newline ? "\n" : ""}`, !newline);
	}

	finish(line: string): OversizedLineResult | undefined {
		if (!this.pending) return;
		const text = isCompleteMarkerParts(this.probe, "") ? "" : line + this.probe;
		this.reset();
		return { kind: "visible", text, overflow: text.length > 0 };
	}

	private classifyPending(
		line: string,
		segment: string,
		newline: boolean,
	): OversizedLineResult {
		if (
			!newline &&
			(isWhitespaceParts(this.probe, segment) ||
				isPotentialParts(this.probe, segment))
		) {
			this.probe = compactPotentialParts(this.probe, segment);
			return { kind: "pending", line };
		}
		return this.visible(
			`${line}${this.probe}${segment}${newline ? "\n" : ""}`,
			!newline,
		);
	}

	private visible(text: string, continuation = false): OversizedLineResult {
		this.reset();
		return { kind: "visible", text, overflow: true, continuation };
	}

	private reset(): void {
		this.pending = false;
		this.probe = "";
	}
}
