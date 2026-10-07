import { parseSubagentWidgetLine } from "./telegram-subagent-status.js";

export type PhysicalLineState = {
	fenced: boolean;
	fenceChar: string;
	fenceLength: number;
	statusReported: boolean;
};

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
		statuses.push(parsed.status);
		state.statusReported = true;
	}
	return parsed.matched ? "" : line + (newline ? "\n" : "");
}

const MARKER = "PI_SUBAGENT_ASYNC_JSON:";

export function isPotentialParts(left: string, right: string): boolean {
	const total = left.length + right.length;
	const charAt = (index: number): string =>
		index < left.length
			? (left[index] as string)
			: (right[index - left.length] as string);
	let cursor = 0;
	while (cursor < total && /\s/.test(charAt(cursor))) cursor++;
	const remaining = total - cursor;
	if (remaining === 0) return false;
	const piPrefix = "Pi:";
	let piMatches = true;
	for (let index = 0; index < Math.min(remaining, piPrefix.length); index++)
		if (charAt(cursor + index) !== piPrefix[index]) piMatches = false;
	if (piMatches && remaining < piPrefix.length) return true;
	if (piMatches && remaining >= piPrefix.length) {
		cursor += piPrefix.length;
		while (cursor < total && /\s/.test(charAt(cursor))) cursor++;
	}
	const chars = total - cursor;
	for (let index = 0; index < Math.min(chars, MARKER.length); index++)
		if (charAt(cursor + index) !== MARKER[index]) return false;
	return true;
}

export function isWhitespaceParts(left: string, right: string): boolean {
	for (const char of left) if (!/\s/.test(char)) return false;
	for (const char of right) if (!/\s/.test(char)) return false;
	return true;
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
