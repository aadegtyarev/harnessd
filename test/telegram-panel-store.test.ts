import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramPanelStore } from "../src/telegram-panel-store.js";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "telegram-panel-store-"),
	);
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Telegram panel state", () => {
	it("persists panel references and independent chat selections per bot", async () => {
		const directory = await temporaryDirectory();
		const first = await TelegramPanelStore.open(directory, "token-one");
		await first.set(42, 1001);
		await first.set(77, 1002);
		await first.setSelected(42, "sid");
		await first.setSelected(77, "other");
		const reopened = await TelegramPanelStore.open(directory, "token-one");
		const separateBot = await TelegramPanelStore.open(directory, "token-two");
		expect(reopened.get(42)).toBe(1001);
		expect(reopened.get(77)).toBe(1002);
		expect(reopened.getSelected(42)).toBe("sid");
		expect(reopened.getSelected(77)).toBe("other");
		expect(separateBot.get(42)).toBeUndefined();
		expect(separateBot.getSelected(42)).toBeUndefined();
		await reopened.delete(42);
		expect(reopened.get(42)).toBeUndefined();
		expect(reopened.getSelected(42)).toBe("sid");
		await reopened.clearSelected(42);
		expect(
			(await TelegramPanelStore.open(directory, "token-one")).getSelected(42),
		).toBeUndefined();
		const contents = await readFile(reopened.filePath, "utf8");
		expect(contents).not.toContain("prompt");
		expect(contents).not.toContain("token-one");
	});

	it("migrates v1 panel state without losing panel references", async () => {
		const directory = await temporaryDirectory();
		const initial = await TelegramPanelStore.open(directory, "token");
		await writeFile(
			initial.filePath,
			JSON.stringify({ version: 1, messages: { "42": 1001 } }),
			{ mode: 0o600 },
		);
		const migrated = await TelegramPanelStore.open(directory, "token");
		expect(migrated.get(42)).toBe(1001);
		expect(migrated.getSelected(42)).toBeUndefined();
		await migrated.setSelected(42, "sid");
		const reopened = await TelegramPanelStore.open(directory, "token");
		expect(reopened.get(42)).toBe(1001);
		expect(reopened.getSelected(42)).toBe("sid");
	});

	it("ignores malformed state and writes the replacement file with private permissions", async () => {
		const directory = await temporaryDirectory();
		const store = await TelegramPanelStore.open(directory, "token");
		await writeFile(store.filePath, "not-json", { mode: 0o600 });
		const reopened = await TelegramPanelStore.open(directory, "token");
		expect(reopened.get(42)).toBeUndefined();
		await reopened.set(42, 7);
		if (process.platform !== "win32")
			expect((await stat(reopened.filePath)).mode & 0o777).toBe(0o600);
	});
});
