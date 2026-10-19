/** Longest string value kept from a scanned head; identifiers and types are short. */
const MAX_SCANNED_STRING = 512;

type ScalarValue = string | boolean | number | null;

interface Frame {
	readonly kind: "object" | "array";
	/** "" for the top-level object, "message" for its `message` object, else undefined. */
	readonly path: string | undefined;
	state: "key" | "colon" | "value" | "comma";
	key?: string;
}

/**
 * Tolerantly scan the start of a JSON object that may be cut at any byte.
 *
 * Returns scalar fields of the top-level object (`type`, `id`, ...) and of its `message`
 * object (`message.role`) that appear completely inside the head. Anything after the cut,
 * malformed syntax, or deeper nesting is ignored; the scan never throws.
 */
export function scanRecordHead(head: string): ReadonlyMap<string, ScalarValue> {
	const fields = new Map<string, ScalarValue>();
	const stack: Frame[] = [];
	let index = 0;
	const store = (frame: Frame, value: ScalarValue): void => {
		if (frame.kind !== "object" || frame.path === undefined || !frame.key)
			return;
		const name = frame.path ? `${frame.path}.${frame.key}` : frame.key;
		if (!fields.has(name)) fields.set(name, value);
	};
	const readString = (): string | undefined | false => {
		// `index` points at the opening quote.
		let end = index + 1;
		for (;;) {
			const next = head.indexOf('"', end);
			if (next < 0) return false;
			let slashes = 0;
			for (let at = next - 1; at > index && head[at] === "\\"; at--) slashes++;
			if (slashes % 2 === 0) {
				end = next;
				break;
			}
			end = next + 1;
		}
		const raw = head.slice(index, end + 1);
		index = end + 1;
		if (raw.length > MAX_SCANNED_STRING + 2) return undefined;
		try {
			return JSON.parse(raw) as string;
		} catch {
			return undefined;
		}
	};
	while (index < head.length) {
		const character = head[index] ?? "";
		if (/\s/.test(character)) {
			index++;
			continue;
		}
		const frame = stack.at(-1);
		if (!frame) {
			if (character !== "{" || index !== head.search(/\S/)) break;
			stack.push({ kind: "object", path: "", state: "key" });
			index++;
			continue;
		}
		if (frame.state === "comma") {
			if (character === ",") {
				frame.state = frame.kind === "object" ? "key" : "value";
				index++;
				continue;
			}
			if (character === (frame.kind === "object" ? "}" : "]")) {
				stack.pop();
				index++;
				continue;
			}
			break;
		}
		if (frame.kind === "object" && frame.state === "key") {
			if (character === "}") {
				stack.pop();
				index++;
				continue;
			}
			if (character !== '"') break;
			const key = readString();
			if (key === false || key === undefined) break;
			frame.key = key;
			frame.state = "colon";
			continue;
		}
		if (frame.state === "colon") {
			if (character !== ":") break;
			frame.state = "value";
			index++;
			continue;
		}
		// A value inside an object or array.
		if (frame.kind === "array" && character === "]") {
			stack.pop();
			index++;
			continue;
		}
		frame.state = "comma";
		if (character === '"') {
			const value = readString();
			if (value === false) break;
			if (value !== undefined) store(frame, value);
			continue;
		}
		if (character === "{" || character === "[") {
			const childPath =
				frame.kind === "object" && frame.path === "" && frame.key === "message"
					? "message"
					: undefined;
			stack.push({
				kind: character === "{" ? "object" : "array",
				path: character === "{" ? childPath : undefined,
				state: character === "{" ? "key" : "value",
			});
			index++;
			continue;
		}
		const literal =
			/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
				head.slice(index, index + 64),
			)?.[0];
		if (!literal) break;
		const after = head[index + literal.length];
		// A literal cut by the head end may be incomplete (for example `tr` or `12`).
		if (after === undefined) break;
		index += literal.length;
		store(
			frame,
			literal === "true"
				? true
				: literal === "false"
					? false
					: literal === "null"
						? null
						: Number(literal),
		);
	}
	return fields;
}
