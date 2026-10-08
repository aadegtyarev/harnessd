import type { AdapterOptions } from "./types.js";

const MAX_BYTES = 8_192;
const SECRET_KEY = /(secret|token|password|credential|api.?key)/i;

export function validateAdapterOptions(value: unknown): AdapterOptions {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new TypeError("Adapter options must be a plain object");
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > MAX_BYTES)
		throw new TypeError("Adapter options exceed the 8192-byte limit");
	const visit = (item: unknown, depth: number): void => {
		if (depth > 5) throw new TypeError("Adapter options exceed nesting limit");
		if (Array.isArray(item)) {
			for (const child of item) visit(child, depth + 1);
			return;
		}
		if (item && typeof item === "object") {
			if (
				!Array.isArray(item) &&
				![Object.prototype, null].includes(Object.getPrototypeOf(item))
			)
				throw new TypeError("Adapter options must contain plain objects");
			for (const [key, child] of Object.entries(item)) {
				if (SECRET_KEY.test(key))
					throw new TypeError("Secret option keys are forbidden");
				visit(child, depth + 1);
			}
		} else if (
			item !== null &&
			(!["string", "number", "boolean"].includes(typeof item) ||
				(typeof item === "number" && !Number.isFinite(item)))
		) {
			throw new TypeError("Adapter options must contain JSON values");
		}
	};
	visit(value, 0);
	return JSON.parse(json) as AdapterOptions;
}

export function mergeAdapterOptions(
	defaults: AdapterOptions | undefined,
	overrides: AdapterOptions | undefined,
): AdapterOptions | undefined {
	if (!defaults && !overrides) return undefined;
	return { ...defaults, ...overrides };
}
