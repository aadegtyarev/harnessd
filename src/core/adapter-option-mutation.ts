import {
	mergeAdapterOptions,
	validateAdapterOptions,
} from "./adapter-options.js";
import { HarnessOptionError } from "./errors.js";
import type { HarnessOptionDescriptor, HarnessOptionUpdate } from "./ports.js";
import type { AdapterOptions } from "./types.js";

export function applyAdapterOptionUpdate(
	defaults: AdapterOptions | undefined,
	overrides: AdapterOptions | undefined,
	options: readonly HarnessOptionDescriptor[] | undefined,
	update: HarnessOptionUpdate,
): AdapterOptions | undefined {
	if (!options) throw new HarnessOptionError("HARNESS_OPTIONS_UNSUPPORTED");
	const set = update.set ? validateAdapterOptions(update.set) : {};
	const resets = update.resetKeys ?? [];
	const known = new Map(options.map((option) => [option.key, option]));
	if (new Set(resets).size !== resets.length)
		throw new HarnessOptionError("INVALID_OPTION_RESET");
	for (const key of resets)
		if (!known.has(key)) throw new Error("UNKNOWN_ADAPTER_OPTION");
	for (const [key, value] of Object.entries(set)) {
		const option = known.get(key);
		if (!option || resets.includes(key))
			throw new HarnessOptionError("UNKNOWN_ADAPTER_OPTION");
		const catalogued = option.values.some((allowed) =>
			Object.is(allowed, value),
		);
		if (!catalogued && !(option.allowCustom && typeof value === "string"))
			throw new HarnessOptionError("INVALID_ADAPTER_OPTION_VALUE");
		if (
			option.dangerousValues?.some((dangerous) =>
				Object.is(dangerous, value),
			) &&
			update.confirmedDangerous !== true
		)
			throw new HarnessOptionError("DANGEROUS_OPTION_CONFIRMATION_REQUIRED");
	}
	const next = { ...overrides };
	for (const key of resets) delete next[key];
	Object.assign(next, set);
	const effective = mergeAdapterOptions(defaults, next);
	for (const option of options) {
		if (
			option.dangerousValues?.some((dangerous) =>
				Object.is(dangerous, effective?.[option.key]),
			) &&
			!Object.is(effective?.[option.key], overrides?.[option.key]) &&
			update.confirmedDangerous !== true
		)
			throw new HarnessOptionError("DANGEROUS_OPTION_CONFIRMATION_REQUIRED");
	}
	return Object.keys(next).length ? next : undefined;
}
