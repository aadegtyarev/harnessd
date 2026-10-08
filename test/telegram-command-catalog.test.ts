import { describe, expect, it } from "vitest";
import {
	extensionCommands,
	paginateTelegramHelp,
	telegramMenuCommands,
} from "../src/telegram-command-catalog.js";

describe("Telegram extension command catalog", () => {
	it("blocks native collisions and sanitizes descriptions", () => {
		const result = extensionCommands([
			{ name: "reload", description: "shadow" },
			{ name: "HELP", description: "invalid" },
			{ name: "cost", description: "safe\n<text>" },
			{ name: "bad/name", description: "invalid" },
		]);
		expect(result).toEqual([{ name: "cost", description: "safe text" }]);
	});

	it("keeps native commands first and limits each menu to Telegram's maximum", () => {
		const extensions = Array.from({ length: 120 }, (_, index) => ({
			name: `extra${String(index).padStart(3, "0")}`,
			description: "Extension",
		}));
		const menu = telegramMenuCommands(extensions);
		expect(menu).toHaveLength(100);
		expect(menu[0]?.command).toBe("start");
		expect(
			menu.findIndex(({ command }) => command === "reload"),
		).toBeGreaterThan(-1);
		expect(menu.slice(-1)[0]?.command).toBe("extra080");
	});

	it("paginates help without exceeding Telegram's message bound", () => {
		const pages = paginateTelegramHelp([
			"native",
			...Array.from({ length: 50 }, (_, i) => `/${i} ${"x".repeat(200)}`),
		]);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.every((page) => page.length <= 4096)).toBe(true);
		expect(pages[0]).toContain("native");
	});
});
