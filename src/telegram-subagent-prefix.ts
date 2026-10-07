const MARKER = "PI_SUBAGENT_ASYNC_JSON:";

export function isPotentialParts(left: string, right: string): boolean {
	const total = left.length + right.length;
	const charAt = (index: number): string =>
		index < left.length
			? (left[index] as string)
			: (right[index - left.length] as string);
	let cursor = skipWhitespace(charAt, total, 0);
	let remaining = total - cursor;
	if (remaining === 0) return false;
	const piPrefix = "Pi:";
	let piMatches = true;
	for (let index = 0; index < Math.min(remaining, piPrefix.length); index++)
		if (charAt(cursor + index) !== piPrefix[index]) piMatches = false;
	if (piMatches && remaining < piPrefix.length) return true;
	if (piMatches && remaining >= piPrefix.length) {
		cursor = skipWhitespace(charAt, total, cursor + piPrefix.length);
		remaining = total - cursor;
	}
	for (let index = 0; index < Math.min(remaining, MARKER.length); index++)
		if (charAt(cursor + index) !== MARKER[index]) return false;
	return remaining <= MARKER.length || matches(charAt, total, cursor, MARKER);
}

export function isCompleteMarkerParts(left: string, right: string): boolean {
	const total = left.length + right.length;
	const charAt = (index: number): string =>
		index < left.length
			? (left[index] as string)
			: (right[index - left.length] as string);
	let cursor = skipWhitespace(charAt, total, 0);
	const piEnd = cursor + 3;
	if (matches(charAt, total, cursor, "Pi:")) {
		cursor = skipWhitespace(charAt, total, piEnd);
	}
	return matches(charAt, total, cursor, MARKER);
}

export function compactPotentialParts(left: string, right: string): string {
	const total = left.length + right.length;
	const charAt = (index: number): string =>
		index < left.length
			? (left[index] as string)
			: (right[index - left.length] as string);
	let cursor = skipWhitespace(charAt, total, 0);
	const remaining = total - cursor;
	const piLength = Math.min(remaining, 3);
	const hasPiPrefix = matches(charAt, total, cursor, "Pi:".slice(0, piLength));
	if (hasPiPrefix && remaining < 3) return "Pi:".slice(0, remaining);
	let prefix = "";
	if (hasPiPrefix && remaining >= 3) {
		prefix = "Pi:";
		cursor = skipWhitespace(charAt, total, cursor + 3);
	}
	let matched = 0;
	while (
		matched < MARKER.length &&
		cursor + matched < total &&
		charAt(cursor + matched) === MARKER[matched]
	)
		matched++;
	return prefix + MARKER.slice(0, matched);
}

function skipWhitespace(
	charAt: (index: number) => string,
	total: number,
	start: number,
): number {
	while (start < total && /\s/.test(charAt(start))) start++;
	return start;
}

function matches(
	charAt: (index: number) => string,
	total: number,
	start: number,
	value: string,
): boolean {
	if (total - start < value.length) return false;
	for (let index = 0; index < value.length; index++)
		if (charAt(start + index) !== value[index]) return false;
	return true;
}
