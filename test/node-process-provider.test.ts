import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedProcess } from "../src/core/ports.js";
import { NodeProcessProvider } from "../src/process/index.js";

const directories: string[] = [];
const processes: ManagedProcess[] = [];
async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-process-"));
	directories.push(directory);
	return directory;
}

function track(process: ManagedProcess): ManagedProcess {
	processes.push(process);
	return process;
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number) {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), milliseconds);
		promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

async function terminateChild(child: ManagedProcess): Promise<void> {
	const settled = child.exit.then(
		() => undefined,
		() => undefined,
	);
	try {
		await child.sendSignal("SIGTERM");
	} catch {
		// The process may already have exited; bounded exit settlement below decides.
	}
	if (await settlesWithin(settled, 1000)) return;
	try {
		await child.sendSignal("SIGKILL");
	} catch {
		// Continue to the final bounded check and report a leaked test child if needed.
	}
	if (!(await settlesWithin(settled, 1000))) {
		throw new Error(`Test child '${child.id}' did not exit after SIGKILL`);
	}
}

afterEach(async () => {
	const childResults = await Promise.allSettled(
		processes.splice(0).map(terminateChild),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
	const failure = childResults.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
});

const provider = new NodeProcessProvider();

describe("NodeProcessProvider", () => {
	it("preserves executable, argv, and cwd including spaces", async () => {
		const cwd = await tempDirectory();
		const output = path.join(cwd, "argument output.json");
		const script =
			"require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }))";
		const managed = track(
			await provider.launch({
				executable: process.execPath,
				args: ["-e", script, "argument with spaces", output],
				cwd,
				env: { PATH: process.env.PATH ?? "" },
			}),
		);
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
		const ambientCoverage = path.join(cwd, "ambient-coverage");
		await mkdir(ambientCoverage);
		const previousValue = process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET;
		const previousCoverage = process.env.NODE_V8_COVERAGE;
		process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET = "ambient-value";
		process.env.NODE_V8_COVERAGE = ambientCoverage;
		try {
			const managed = track(
				await provider.launch({
					executable: process.execPath,
					args: [
						"-e",
						`require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ secret: process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET ?? 'missing', coverage: process.env.NODE_V8_COVERAGE ?? 'missing' }))`,
					],
					cwd,
				}),
			);
			expect(await managed.exit).toEqual({ code: 0, signal: null });
			expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
				secret: "missing",
				coverage: "missing",
			});
			expect(await readdir(ambientCoverage)).toEqual([]);
		} finally {
			if (previousValue === undefined) {
				delete process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET;
			} else {
				process.env.HARNESSD_PROCESS_PROVIDER_TEST_SECRET = previousValue;
			}
			if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
			else process.env.NODE_V8_COVERAGE = previousCoverage;
		}
	});

	it("preserves an explicitly supplied NODE_V8_COVERAGE value", async () => {
		const cwd = await tempDirectory();
		const output = path.join(cwd, "coverage-env.txt");
		const coverageDirectory = path.join(cwd, "provided-coverage");
		await mkdir(coverageDirectory);
		const previousCoverage = process.env.NODE_V8_COVERAGE;
		process.env.NODE_V8_COVERAGE = path.join(cwd, "ambient-coverage");
		try {
			const managed = track(
				await provider.launch({
					executable: process.execPath,
					args: [
						"-e",
						`require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.NODE_V8_COVERAGE ?? 'missing')`,
					],
					cwd,
					env: { NODE_V8_COVERAGE: coverageDirectory },
				}),
			);
			expect(await managed.exit).toEqual({ code: 0, signal: null });
			expect(await readFile(output, "utf8")).toBe(coverageDirectory);
			expect(await readdir(coverageDirectory)).not.toEqual([]);
		} finally {
			if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
			else process.env.NODE_V8_COVERAGE = previousCoverage;
		}
	});

	it("rejects startup errors for a missing executable", async () => {
		await expect(
			provider.launch({
				executable: path.join(os.tmpdir(), `missing-${randomUUID()}`),
				args: [],
				cwd: os.tmpdir(),
			}),
		).rejects.toThrow("Process failed to start");
	});

	it("delivers a valid signal on POSIX", async () => {
		if (process.platform === "win32") return;
		const managed = track(
			await provider.launch({
				executable: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cwd: os.tmpdir(),
				env: { PATH: process.env.PATH ?? "" },
			}),
		);
		await managed.sendSignal("SIGTERM");
		const result = await managed.exit;
		expect(result.signal).toBe("SIGTERM");
	});

	it("rejects invalid signals", async () => {
		const managed = track(
			await provider.launch({
				executable: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cwd: os.tmpdir(),
				env: { PATH: process.env.PATH ?? "" },
			}),
		);
		await expect(managed.sendSignal("NOT_A_SIGNAL")).rejects.toThrow(
			"Invalid process signal",
		);
		await managed.sendSignal("SIGTERM");
		await managed.exit;
	});
});
