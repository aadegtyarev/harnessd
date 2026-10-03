import { describe, expect, it } from "vitest";
import {
	COMMAND_CATALOG,
	getCliCommandUsages,
	getTelegramCommands,
	getTelegramHelpUsages,
} from "../src/command-catalog.js";

describe("shared command catalog", () => {
	it("derives CLI help and Telegram menu/help with explicit surface visibility", () => {
		const cliUsages = getCliCommandUsages("private-chat").map(
			({ usage }) => usage,
		);
		const telegramCommands = getTelegramCommands();
		const telegramUsages = getTelegramHelpUsages();

		expect(cliUsages).toContain("/ls [path]");
		expect(cliUsages).toContain("/cd [path]");
		expect(cliUsages).not.toContain("/menu");
		expect(cliUsages).not.toContain("/rename [sessionId] <name|--clear>");
		expect(cliUsages).not.toContain("/status");
		expect(cliUsages).not.toContain("/delete <sessionId>");
		expect(telegramCommands.map(({ command }) => command)).toContain("ls");
		expect(telegramCommands.map(({ command }) => command)).toContain("cd");
		expect(telegramUsages).toContain("/ls [path]");
		expect(telegramUsages).toContain("/cd [path]");
		expect(telegramUsages).toContain("/menu");
		expect(telegramUsages).toContain("/rename [sessionId] <name|--clear>");
		expect(telegramUsages).toContain("/status");
		expect(getCliCommandUsages("service")).toEqual([
			{
				usage: "harnessd service install",
				description: "Install, enable, and start the user service.",
			},
			{
				usage: "harnessd service uninstall",
				description: "Stop, disable, and remove the user service.",
			},
		]);
	});

	it("has Telegram menu metadata for every command visible there", () => {
		for (const entry of COMMAND_CATALOG) {
			if (entry.visibility === "cli-only") continue;
			expect(entry.telegram.command).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(entry.telegram.description.length).toBeGreaterThan(0);
		}
	});
});
