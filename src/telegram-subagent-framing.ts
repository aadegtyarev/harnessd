export function isPotential(line: string): boolean {
	let text = line.trimStart();
	if (text.length === 0) return line.length > 0;
	if ("Pi:".startsWith(text)) return true;
	if (text.startsWith("Pi:")) text = text.slice(3).trimStart();
	return (
		text.startsWith("PI_SUBAGENT_ASYNC_JSON:") ||
		"PI_SUBAGENT_ASYNC_JSON:".startsWith(text)
	);
}

export function mightBeFence(line: string): boolean {
	return /^ {0,3}(?:`{1,2}|~{1,2})?$/.test(line);
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
	const fence = fenceDelimiter(line);
	return !!fence && fence.char === char && fence.length >= length;
}
