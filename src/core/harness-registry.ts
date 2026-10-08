import type { HarnessAdapter, HarnessRegistryEntry } from "./ports.js";
import type { AdapterId } from "./types.js";

export class HarnessRegistry {
	private readonly aliases = new Map<string, AdapterId>();
	private readonly entries = new Map<AdapterId, HarnessRegistryEntry>();

	constructor(adapters: readonly HarnessAdapter[]) {
		for (const adapter of adapters) {
			const { id, capabilities, aliases = [], metadata } = adapter.descriptor;
			if (this.entries.has(id)) throw new Error(`Duplicate harness ID: ${id}`);
			for (const key of [id, ...aliases]) {
				if (!/^[a-z][a-z0-9-]{0,63}$/.test(key) || this.aliases.has(key))
					throw new Error(`Invalid or duplicate harness alias: ${key}`);
				this.aliases.set(key, id);
			}
			this.entries.set(id, {
				id,
				aliases: [...aliases],
				capabilities: [...new Set(capabilities)],
				...(metadata ? { metadata: { ...metadata } } : {}),
			});
		}
	}

	resolve(idOrAlias: string): AdapterId | undefined {
		return this.aliases.get(idOrAlias);
	}

	get(id: AdapterId): HarnessRegistryEntry | undefined {
		return this.entries.get(id);
	}

	project(capabilities: readonly string[]): readonly HarnessRegistryEntry[] {
		const requested = new Set(capabilities);
		return [...this.entries.values()].filter((entry) =>
			entry.capabilities.some((capability) => requested.has(capability)),
		);
	}

	list(): readonly HarnessRegistryEntry[] {
		return [...this.entries.values()];
	}
}
