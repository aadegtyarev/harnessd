import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	manageUserService,
	renderUserServiceUnit,
	resolveUnitDirectory,
	USER_SERVICE_NAME,
} from "../src/user-service.js";

const temporaryDirectories: string[] = [];
const baseOptions = {
	cwd: "/tmp/harnessd workspace",
	nodeExecutable: "/usr/bin/node",
	cliEntryPoint: "/opt/harnessd/dist/src/cli.js",
	platform: "linux" as NodeJS.Platform,
	env: {} as NodeJS.ProcessEnv,
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-service-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("per-user systemd service", () => {
	it("renders a user unit with escaped paths and no environment secrets", () => {
		const contents = renderUserServiceUnit({
			cwd: "/home/operator/harnessd project",
			nodeExecutable: "/home/operator/node/bin/node",
			cliEntryPoint: "/home/operator/harnessd project/dist/src/cli.js",
		});

		expect(contents).toContain("# Managed by harnessd");
		expect(contents).toContain(
			"WorkingDirectory=/home/operator/harnessd project",
		);
		expect(contents).toContain(
			'ExecStart="/home/operator/node/bin/node" "/home/operator/harnessd project/dist/src/cli.js"',
		);
		expect(contents).toContain("WantedBy=default.target");
		expect(contents).not.toContain("TELEGRAM_BOT_TOKEN");
		expect(contents).not.toContain("Restart=");
		const unusualPath = renderUserServiceUnit({
			cwd: '/home/operator/work %literal\\backslash"quote\ttab',
			nodeExecutable: "/home/operator/node/bin/node",
			cliEntryPoint: "/home/operator/harnessd/dist/src/cli.js",
		});
		expect(unusualPath).toContain(
			'WorkingDirectory=/home/operator/work %%literal\\backslash"quote\ttab',
		);
		const trailingSpacePath = renderUserServiceUnit({
			cwd: "/home/operator/work ",
			nodeExecutable: "/home/operator/node/bin/node",
			cliEntryPoint: "/home/operator/harnessd/dist/src/cli.js",
		});
		expect(trailingSpacePath).toContain(
			"WorkingDirectory=/home/operator/work /.",
		);
		const trailingBackslashPath = renderUserServiceUnit({
			cwd: "/home/operator/work\\",
			nodeExecutable: "/home/operator/node/bin/node",
			cliEntryPoint: "/home/operator/harnessd/dist/src/cli.js",
		});
		expect(trailingBackslashPath).toContain(
			"WorkingDirectory=/home/operator/work\\/.",
		);
		const dollarPath = renderUserServiceUnit({
			cwd: "/home/operator/harnessd",
			nodeExecutable: "/home/operator/node$dollar/bin/node",
			cliEntryPoint: "/home/operator/harnessd/cli$dollar.js",
		});
		expect(dollarPath).toContain(
			'ExecStart="/home/operator/node$dollar/bin/node" "/home/operator/harnessd/cli$$dollar.js"',
		);
	});

	it("installs a private managed unit and enables it without invoking a shell", async () => {
		const root = await createDirectory();
		const unitDirectory = path.join(root, "systemd", "user");
		const systemctl = vi.fn(async (_args: readonly string[]) => {});
		const write = vi.fn();

		await manageUserService("install", {
			...baseOptions,
			unitDirectory,
			systemctl,
			write,
		});

		const unitPath = path.join(unitDirectory, USER_SERVICE_NAME);
		const contents = await readFile(unitPath, "utf8");
		expect(contents).toContain("WorkingDirectory=/tmp/harnessd workspace");
		expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
		expect(systemctl.mock.calls).toEqual([
			[["daemon-reload"]],
			[["enable", "--now", USER_SERVICE_NAME]],
		]);
		expect(write).toHaveBeenCalledWith(
			"Installed and started the harnessd user service.\n",
		);
	});

	it("refuses to overwrite an unmanaged unit", async () => {
		const root = await createDirectory();
		const unitDirectory = path.join(root, "systemd", "user");
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(unitDirectory, { recursive: true }),
		);
		const unitPath = path.join(unitDirectory, USER_SERVICE_NAME);
		await writeFile(unitPath, "[Service]\nExecStart=/custom/service\n");
		const systemctl = vi.fn(async (_args: readonly string[]) => {});

		await expect(
			manageUserService("install", {
				...baseOptions,
				unitDirectory,
				systemctl,
			}),
		).rejects.toThrow("HARNESSD_SERVICE_UNIT_NOT_MANAGED_BY_HARNESSD");
		expect(await readFile(unitPath, "utf8")).toBe(
			"[Service]\nExecStart=/custom/service\n",
		);
		expect(systemctl).not.toHaveBeenCalled();
	});

	it("uninstalls only its managed unit and leaves neighboring files intact", async () => {
		const root = await createDirectory();
		const unitDirectory = path.join(root, "systemd", "user");
		const unitPath = path.join(unitDirectory, USER_SERVICE_NAME);
		const otherFile = path.join(root, ".env");
		const systemctl = vi.fn(async (_args: readonly string[]) => {});
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(unitDirectory, { recursive: true }),
		);
		await writeFile(
			unitPath,
			renderUserServiceUnit({
				cwd: baseOptions.cwd,
				nodeExecutable: baseOptions.nodeExecutable,
				cliEntryPoint: baseOptions.cliEntryPoint,
			}),
		);
		await writeFile(otherFile, "keep me");

		await manageUserService("uninstall", {
			...baseOptions,
			unitDirectory,
			systemctl,
		});

		expect(systemctl.mock.calls).toEqual([
			[["disable", "--now", USER_SERVICE_NAME]],
			[["daemon-reload"]],
		]);
		await expect(readFile(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(otherFile, "utf8")).toBe("keep me");
	});

	it("keeps the unit in place when systemctl cannot stop it", async () => {
		const root = await createDirectory();
		const unitDirectory = path.join(root, "systemd", "user");
		const unitPath = path.join(unitDirectory, USER_SERVICE_NAME);
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(unitDirectory, { recursive: true }),
		);
		await writeFile(
			unitPath,
			renderUserServiceUnit({
				cwd: baseOptions.cwd,
				nodeExecutable: baseOptions.nodeExecutable,
				cliEntryPoint: baseOptions.cliEntryPoint,
			}),
		);
		const systemctl = vi.fn(async () => {
			throw new Error("private manager diagnostic");
		});

		await expect(
			manageUserService("uninstall", {
				...baseOptions,
				unitDirectory,
				systemctl,
			}),
		).rejects.toThrow("private manager diagnostic");
		expect(await readFile(unitPath, "utf8")).toContain("Managed by harnessd");
	});

	it("uses a stable home config directory or the process XDG directory", async () => {
		await expect(
			manageUserService("install", {
				...baseOptions,
				platform: "darwin",
				unitDirectory: "/tmp/harnessd-unit",
			}),
		).rejects.toThrow("HARNESSD_SERVICE_REQUIRES_LINUX_SYSTEMD_USER");
		expect(resolveUnitDirectory({})).toBe(
			path.join(os.homedir(), ".config", "systemd", "user"),
		);
		expect(
			resolveUnitDirectory({ XDG_CONFIG_HOME: "/tmp/custom-config" }),
		).toBe(path.join("/tmp/custom-config", "systemd", "user"));
		expect(() => resolveUnitDirectory({ XDG_CONFIG_HOME: "relative" })).toThrow(
			"HARNESSD_SERVICE_XDG_CONFIG_HOME_MUST_BE_ABSOLUTE",
		);
	});

	it("rejects Node executable paths systemd cannot parse", () => {
		for (const nodeExecutable of [
			"/tmp/node\\with-backslash",
			"/tmp/node'with-apostrophe",
			"/tmp/node\u0001control",
			"/tmp/node\u007f",
		]) {
			expect(() =>
				renderUserServiceUnit({
					cwd: baseOptions.cwd,
					nodeExecutable,
					cliEntryPoint: baseOptions.cliEntryPoint,
				}),
			).toThrow("HARNESSD_SERVICE_NODE_EXECUTABLE_PATH_UNSUPPORTED");
		}
	});

	it("leaves the generated unit available when install activation fails", async () => {
		const root = await createDirectory();
		const unitDirectory = path.join(root, "systemd", "user");
		const systemctl = vi.fn(async () => {
			throw new Error("private manager diagnostic");
		});

		await expect(
			manageUserService("install", {
				...baseOptions,
				unitDirectory,
				systemctl,
			}),
		).rejects.toThrow("private manager diagnostic");
		expect(systemctl).toHaveBeenCalledWith(["daemon-reload"]);
		expect(
			await readFile(path.join(unitDirectory, USER_SERVICE_NAME), "utf8"),
		).toContain("Managed by harnessd");
	});
});
