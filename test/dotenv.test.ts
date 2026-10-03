import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/dotenv.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-dotenv-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("dotenv configuration", () => {
	it("loads standard dotenv values without overriding the process environment", async () => {
		const cwd = await createDirectory();
		await writeFile(
			path.join(cwd, ".env"),
			[
				"HARNESSD_TELEGRAM_BOT_TOKEN=from-file",
				"HARNESSD_TELEGRAM_ALLOWED_USER_IDS=42,43",
				"HARNESSD_DEFAULT_CWD='/work/project root'",
			].join("\n"),
		);
		const env: NodeJS.ProcessEnv = {
			HARNESSD_TELEGRAM_BOT_TOKEN: "from-shell",
		};

		const values = await loadDotEnv(cwd, env);

		expect(env.HARNESSD_TELEGRAM_BOT_TOKEN).toBe("from-shell");
		expect(env.HARNESSD_TELEGRAM_ALLOWED_USER_IDS).toBe("42,43");
		expect(env.HARNESSD_DEFAULT_CWD).toBe("/work/project root");
		expect(values.HARNESSD_TELEGRAM_BOT_TOKEN).toBe("from-file");
	});

	it("treats a missing .env as optional", async () => {
		const cwd = await createDirectory();
		const env: NodeJS.ProcessEnv = { EXISTING: "value" };

		await expect(loadDotEnv(cwd, env)).resolves.toEqual({});
		expect(env).toEqual({ EXISTING: "value" });
	});

	it("reports a safe error when .env is not a readable file", async () => {
		const cwd = await createDirectory();
		await mkdir(path.join(cwd, ".env"));

		await expect(loadDotEnv(cwd, {})).rejects.toThrow(
			"HARNESSD_ENV_FILE_READ_FAILED",
		);
	});
});
