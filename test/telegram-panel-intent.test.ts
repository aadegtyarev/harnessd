import { describe, expect, it } from "vitest";
import { TelegramPanelIntent } from "../src/telegram-panel-intent.js";

describe("TelegramPanelIntent", () => {
	it("invalidates only the chat whose newer view or action began", () => {
		const intents = new TelegramPanelIntent();
		const firstChatView = intents.begin(41);
		const otherChatView = intents.begin(42);

		intents.begin(41);

		expect(intents.isCurrent(41, firstChatView)).toBe(false);
		expect(intents.isCurrent(42, otherChatView)).toBe(true);
	});
});
