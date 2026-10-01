import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessProvider } from "../src/process/index.js";

const directories: string[] = [];
async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-process-"));
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

const provider = new NodeProcessProvider();

describe("NodeProcessProvider", () => {
	it("preserves executable, argv, and cwd including spaces", async () => {
		const cwd = await tempDirectory();
		const output = path.join(cwd, "argument output.json");
		const script =
			"require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }))";
		const managed = await provider.launch({
			executable: process.execPath,
			args: ["-e", script, "argument with spaces", output],
			cwd,
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(managed.id).toBeTruthy();
		expect(await managed.exit).toEqual({ code: 0, signal: null });
		expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
			argv: ["argument with spaces", output],
			cwd,
		});
	});

	it("does not inherit ambient environment when env is omitted", async () => {
		const cwd = await tempDirectory();
		const output = path.join(cwd, "environment.txt");
		const previousValue = process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET;
		process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET = "ambient-value";
		try {
			const managed = await provider.launch({
				executable: process.execPath,
				args: [
					"-e",
					`require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET ?? 'missing')`,
				],
				cwd,
			});
			expect(await managed.exit).toEqual({ code: 0, signal: null });
			expect(await readFile(output, "utf8")).toBe("missing");
		} finally {
			if (previousValue === undefined) {
				delete process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET;
			} else {
				process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET = previousValue;
			}
		}
	});

	it("rejects startup errors for a missing executable", async () => {
		await expect(
			provider.launch({
				executable: path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`),
				args: [],
				cwd: os.tmpdir(),
			}),
		).rejects.toThrow("Process failed to start");
	});

	it("delivers a valid signal on POSIX", async () => {
		if (process.platform === "win32") return;
		const managed = await provider.launch({
			executable: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: os.tmpdir(),
			env: { PATH: process.env.PATH ?? "" },
		});
		await managed.sendSignal("SIGTERM");
		const result = await managed.exit;
		expect(result.signal).toBe("SIGTERM");
	});

	it("rejects invalid signals", async () => {
		const managed = await provider.launch({
			executable: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: os.tmpdir(),
			env: { PATH: process.env.PATH ?? "" },
		});
		await expect(managed.sendSignal("NOT_A_SIGNAL")).rejects.toThrow(
			"Invalid process signal",
		);
		await managed.sendSignal("SIGTERM");
		await managed.exit;
	});
});
