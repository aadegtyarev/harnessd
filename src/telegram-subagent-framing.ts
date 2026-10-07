import { isPotentialParts } from "./telegram-subagent-prefix.js";
import { parseSubagentWidgetLine } from "./telegram-subagent-status.js";

export type PhysicalLineState = {
	fenced: boolean;
	fenceChar: string;
	fenceLength: number;
	statusReported: boolean;
};

export function reportPartialSubagentStatus(
	line: string,
	state: PhysicalLineState,
	statuses: string[],
): void {
	if (state.fenced || !isPotentialParts(line, "")) return;
	const parsed = parseSubagentWidgetLine(line);
	if (parsed.status && !state.statusReported) {
		statuses.push(...(parsed.statuses ?? [parsed.status]));
		state.statusReported = true;
	}
}

export function finishPhysicalLine(
	line: string,
	state: PhysicalLineState,
	statuses: string[],
	newline = true,
): string {
	if (state.fenced) {
		if (closesFence(line, state.fenceChar, state.fenceLength))
			state.fenced = false;
		return line + (newline ? "\n" : "");
	}
	const fence = fenceDelimiter(line);
	if (fence) {
		state.fenced = true;
		state.fenceChar = fence.char;
		state.fenceLength = fence.length;
		return line + (newline ? "\n" : "");
	}
	const parsed = parseSubagentWidgetLine(line);
	if (parsed.status && !state.statusReported) {
		statuses.push(...(parsed.statuses ?? [parsed.status]));
		state.statusReported = true;
	}
	return parsed.matched ? "" : line + (newline ? "\n" : "");
}

export function fenceDelimiter(
	line: string,
): { char: string; length: number } | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
	const fence = match?.[1];
	return fence ? { char: fence[0] as string, length: fence.length } : undefined;
}

export function closesFence(
	line: string,
	char: string,
	length: number,
): boolean {
	const match = /^ {0,3}(`+|~+)[ \t]*\r?$/.exec(line);
	const fence = match?.[1];
	return fence !== undefined && fence[0] === char && fence.length >= length;
}
