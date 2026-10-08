import { describe, expect, it } from "vitest";
import type { HarnessRegistryEntry } from "../src/core/ports.js";
import { parseNewHarnessSelection } from "../src/telegram-harness-selection.js";

const harnesses: readonly HarnessRegistryEntry[] = [
	{
		id: "claude-code" as never,
		aliases: ["claude"],
		capabilities: ["harness.launch"],
	},
];

describe("Telegram /new harness selection", () => {
	it("parses a known alias separately from a path containing spaces", () => {
		expect(
			parseNewHarnessSelection("@claude /workspace/my project", harnesses),
		).toEqual({
			ok: true,
			harnessId: "claude-code",
			cwdArgument: "/workspace/my project",
		});
	});

	it("leaves the default harness unspecified and rejects unknown aliases", () => {
		expect(
			parseNewHarnessSelection("/workspace/my project", harnesses),
		).toEqual({
			ok: true,
			cwdArgument: "/workspace/my project",
		});
		expect(parseNewHarnessSelection("@missing /workspace", harnesses)).toEqual({
			ok: false,
			reason: "unknown_harness",
		});
	});
});
