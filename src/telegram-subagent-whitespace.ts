export function isWhitespaceParts(left: string, right: string): boolean {
	for (const char of left) if (!/\s/.test(char)) return false;
	for (const char of right) if (!/\s/.test(char)) return false;
	return true;
}

export function leadingWhitespacePrefix(
	left: string,
	right: string,
	limit: number,
): string {
	const total = left.length + right.length;
	const charAt = (index: number): string =>
		index < left.length
			? (left[index] as string)
			: (right[index - left.length] as string);
	let count = 0;
	while (count < total && count < limit && /\s/.test(charAt(count))) count++;
	const fromLeft = Math.min(count, left.length);
	return left.slice(0, fromLeft) + right.slice(0, count - fromLeft);
}
