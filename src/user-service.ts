import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const USER_SERVICE_NAME = "harnessd.service";
const MANAGED_MARKER = "# Managed by harnessd; do not edit this unit directly.";

export type UserServiceAction = "install" | "uninstall";

export interface UserServiceOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly nodeExecutable: string;
	readonly cliEntryPoint: string;
	readonly platform?: NodeJS.Platform;
	readonly unitDirectory?: string;
	readonly systemctl?: (args: readonly string[]) => Promise<void>;
	readonly write?: (message: string) => void;
}

export async function manageUserService(
	action: UserServiceAction,
	options: UserServiceOptions,
): Promise<void> {
	if ((options.platform ?? process.platform) !== "linux")
		throw new Error("HARNESSD_SERVICE_REQUIRES_LINUX_SYSTEMD_USER");
	const unitDirectory =
		options.unitDirectory ?? resolveUnitDirectory(options.env);
	if (!path.isAbsolute(unitDirectory))
		throw new Error("HARNESSD_SERVICE_CONFIG_DIRECTORY_MUST_BE_ABSOLUTE");
	const unitPath = path.join(unitDirectory, USER_SERVICE_NAME);
	const systemctl = options.systemctl ?? runSystemctl;

	if (action === "install") {
		const contents = renderUserServiceUnit({
			cwd: options.cwd,
			nodeExecutable: options.nodeExecutable,
			cliEntryPoint: options.cliEntryPoint,
		});
		await writeManagedUnit(unitDirectory, unitPath, contents);
		await systemctl(["daemon-reload"]);
		await systemctl(["enable", "--now", USER_SERVICE_NAME]);
		options.write?.("Installed and started the harnessd user service.\n");
		return;
	}

	const existing = await readManagedUnit(unitPath);
	if (existing === undefined) {
		options.write?.("The harnessd user service is not installed.\n");
		return;
	}
	await systemctl(["disable", "--now", USER_SERVICE_NAME]);
	await unlink(unitPath);
	await systemctl(["daemon-reload"]);
	options.write?.("Removed the harnessd user service.\n");
}

export function renderUserServiceUnit(options: {
	readonly cwd: string;
	readonly nodeExecutable: string;
	readonly cliEntryPoint: string;
}): string {
	for (const [label, value] of Object.entries(options)) {
		if (!path.isAbsolute(value))
			throw new Error(
				`HARNESSD_SERVICE_${label.toUpperCase()}_MUST_BE_ABSOLUTE`,
			);
		if (/[\0\r\n]/.test(value))
			throw new Error(`HARNESSD_SERVICE_INVALID_${label.toUpperCase()}`);
		if (label === "nodeExecutable" && !isSystemdSafeExecutablePath(value))
			throw new Error("HARNESSD_SERVICE_NODE_EXECUTABLE_PATH_UNSUPPORTED");
	}
	return `${MANAGED_MARKER}
[Unit]
Description=harnessd Telegram session supervisor

[Service]
Type=simple
WorkingDirectory=${escapeUnitPath(options.cwd)}
ExecStart=${quoteExecExecutable(options.nodeExecutable)} ${quoteExecArgument(options.cliEntryPoint)}
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=30s

[Install]
WantedBy=default.target
`;
}

export function resolveUnitDirectory(env: NodeJS.ProcessEnv): string {
	const xdgConfigHome = env.XDG_CONFIG_HOME;
	if (xdgConfigHome) {
		if (!path.isAbsolute(xdgConfigHome))
			throw new Error("HARNESSD_SERVICE_XDG_CONFIG_HOME_MUST_BE_ABSOLUTE");
		return path.join(xdgConfigHome, "systemd", "user");
	}
	return path.join(os.homedir(), ".config", "systemd", "user");
}

async function writeManagedUnit(
	unitDirectory: string,
	unitPath: string,
	contents: string,
): Promise<void> {
	await readManagedUnit(unitPath);
	await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
	const temporaryPath = `${unitPath}.${process.pid}.${randomUUID()}.tmp`;
	let temporaryCreated = false;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		await handle.writeFile(contents);
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, unitPath);
		temporaryCreated = false;
	} catch (error) {
		try {
			await handle?.close();
			if (temporaryCreated) await unlink(temporaryPath);
		} catch {
			// Preserve the original write/rename error.
		}
		throw error;
	}
}

async function readManagedUnit(unitPath: string): Promise<string | undefined> {
	try {
		const metadata = await lstat(unitPath);
		if (!metadata.isFile())
			throw new Error("HARNESSD_SERVICE_UNIT_PATH_NOT_REGULAR_FILE");
		const contents = await readFile(unitPath, "utf8");
		if (!contents.startsWith(`${MANAGED_MARKER}\n`))
			throw new Error("HARNESSD_SERVICE_UNIT_NOT_MANAGED_BY_HARNESSD");
		return contents;
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		if (error instanceof Error && error.message.startsWith("HARNESSD_"))
			throw error;
		throw new Error("HARNESSD_SERVICE_UNIT_READ_FAILED");
	}
}

function isSystemdSafeExecutablePath(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			(codePoint > 0 && codePoint < 0x20) ||
			codePoint === 0x7f ||
			character === "'" ||
			character === '"' ||
			character === "\\"
		)
			return false;
	}
	return true;
}

function escapeUnitPath(value: string): string {
	const safeTrailingCharacter = /[ \t\\]$/.test(value) ? `${value}/.` : value;
	return safeTrailingCharacter.replaceAll("%", "%%");
}

function quoteExecExecutable(value: string): string {
	return `"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("%", "%%")}"`;
}

function quoteExecArgument(value: string): string {
	return `"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("%", "%%")
		.replaceAll("$", () => "$$")}"`;
}

function runSystemctl(args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"systemctl",
			["--user", ...args],
			{ timeout: 30_000, windowsHide: true },
			(error) => {
				if (error) {
					reject(
						new Error(
							`HARNESSD_SERVICE_SYSTEMCTL_FAILED:${args[0] ?? "unknown"}:${error.code ?? "UNKNOWN"}`,
						),
					);
					return;
				}
				resolve();
			},
		);
	});
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
