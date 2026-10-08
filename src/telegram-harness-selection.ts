import type { HarnessRegistryEntry } from "./core/ports.js";
import type { AdapterId } from "./core/types.js";
import { parsePathArgument } from "./telegram-filesystem.js";

export type NewHarnessSelection =
	| {
			readonly ok: true;
			readonly cwdArgument?: string;
			readonly harnessId?: AdapterId;
	  }
	| { readonly ok: false; readonly reason: "invalid_path" | "unknown_harness" };

export function parseNewHarnessSelection(
	value: string | undefined,
	harnesses: readonly HarnessRegistryEntry[],
): NewHarnessSelection {
	const candidate = value?.trim();
	if (!candidate) return { ok: true };
	const aliasMatch = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(candidate);
	if (candidate.startsWith("@")) {
		if (!aliasMatch) return { ok: false, reason: "unknown_harness" };
		const key = aliasMatch[1]?.toLowerCase();
		const entry = harnesses.find(({ id, aliases }) =>
			[id, ...aliases].some((alias) => alias.toLowerCase() === key),
		);
		if (!entry) return { ok: false, reason: "unknown_harness" };
		const path = parsePathArgument(aliasMatch[2]);
		return path.ok
			? {
					ok: true,
					harnessId: entry.id,
					...(path.path ? { cwdArgument: path.path } : {}),
				}
			: { ok: false, reason: "invalid_path" };
	}
	const path = parsePathArgument(candidate);
	return path.ok
		? { ok: true, ...(path.path ? { cwdArgument: path.path } : {}) }
		: { ok: false, reason: "invalid_path" };
}
