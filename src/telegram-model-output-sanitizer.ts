const MARKER_LINE = /^(?:Stop\.|No\.|End\.|Done\.|At [0-9]+\.)$/;

/** Removes only the strict, terminal model-garbage signature from Telegram presentation text. */
export function stripModelOutputGarbageTail(text: string): string {
	const lines = text.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	for (let start = 0; start < lines.length; start++) {
		if (lineValue(lines[start] ?? "") !== "xx" || isInsideFence(lines, start))
			continue;
		let cursor = start + 1;
		while (cursor < lines.length && isBlank(lines[cursor] ?? "")) cursor++;
		if (lineValue(lines[cursor] ?? "") !== "hidden.") continue;
		cursor++;
		let markers = 0;
		let valid = true;
		for (; cursor < lines.length; cursor++) {
			const line = lines[cursor] ?? "";
			if (isBlank(line)) continue;
			if (!MARKER_LINE.test(lineValue(line))) {
				valid = false;
				break;
			}
			markers++;
		}
		if (valid && markers >= 3) {
			const boundary = starts[start] ?? text.length;
			return text.slice(0, boundary).replace(/(?:\r?\n)+$/, "");
		}
	}
	return text;
}

function isBlank(line: string): boolean {
	return line === "" || line === "\r";
}

function lineValue(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isInsideFence(lines: readonly string[], end: number): boolean {
	let fence: { marker: string; length: number } | undefined;
	for (let index = 0; index < end; index++) {
		const match = /^ {0,3}(`{3,}|~{3,})/.exec(lineValue(lines[index] ?? ""));
		if (!match) continue;
		const marker = match[1]?.[0];
		const length = match[1]?.length ?? 0;
		if (!marker) continue;
		if (!fence) fence = { marker, length };
		else if (marker === fence.marker && length >= fence.length)
			fence = undefined;
	}
	return fence !== undefined;
}
