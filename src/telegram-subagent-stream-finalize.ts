import {
	finishPhysicalLine,
	type PhysicalLineState,
} from "./telegram-subagent-framing.js";
import type { OversizedLineClassifier } from "./telegram-subagent-overflow.js";

export function finalizeSubagentStream(
	line: string,
	framing: PhysicalLineState,
	oversized: OversizedLineClassifier,
	statuses: string[],
): { visibleText: string; overflow: boolean } {
	const resolved = oversized.finish(line);
	if (resolved)
		return {
			visibleText: resolved.text ?? "",
			overflow: resolved.overflow ?? false,
		};
	if (!line) return { visibleText: "", overflow: false };
	return {
		visibleText: framing.fenced
			? line
			: finishPhysicalLine(line, framing, statuses, false),
		overflow: false,
	};
}
