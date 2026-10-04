import { constants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_LIST_ENTRIES = 100;

export class DirectoryResolutionError extends Error {
	constructor() {
		super("Directory is missing, inaccessible, or not a directory.");
		this.name = "DirectoryResolutionError";
	}
}

export function parsePathArgument(
	value: string | undefined,
):
	| { readonly ok: true; readonly path: string | undefined }
	| { readonly ok: false } {
	const candidate = value?.trim();
	if (!candidate) return { ok: true, path: undefined };
	const quote = candidate[0];
	if (quote === '"' || quote === "'") {
		if (candidate.length < 2 || candidate.at(-1) !== quote)
			return { ok: false };
		const parsed = candidate.slice(1, -1);
		return parsed ? { ok: true, path: parsed } : { ok: false };
	}
	return { ok: true, path: candidate };
}

export function expandUserHome(value: string, userHome = os.homedir()): string {
	if (value === "~") return userHome;
	if (value.startsWith("~/") || value.startsWith("~\\"))
		return path.join(userHome, value.slice(2));
	return value;
}

export function resolvePathFrom(
	value: string,
	baseDirectory: string,
	userHome = os.homedir(),
): string {
	const expanded = expandUserHome(value, userHome);
	return path.isAbsolute(expanded)
		? path.resolve(expanded)
		: path.resolve(baseDirectory, expanded);
}

export async function resolveInitialDirectory(
	configuredHome: string | undefined,
	processCwd = process.cwd(),
	userHome = os.homedir(),
): Promise<string> {
	const configured = configuredHome?.trim();
	const systemRoot = path.parse(path.resolve(processCwd)).root || path.sep;
	const initialPath = configured
		? resolvePathFrom(configured, processCwd, userHome)
		: systemRoot;
	return resolveExistingDirectory(initialPath);
}

export async function resolveExistingDirectory(
	candidate: string,
): Promise<string> {
	try {
		const canonical = await realpath(candidate);
		if (!(await stat(canonical)).isDirectory())
			throw new DirectoryResolutionError();
		await access(canonical, constants.R_OK | constants.X_OK);
		return canonical;
	} catch {
		throw new DirectoryResolutionError();
	}
}

export interface ListedDirectory {
	readonly cwd: string;
	readonly entries: readonly {
		readonly name: string;
		readonly kind: "directory" | "file";
	}[];
	readonly total: number;
	readonly truncated: boolean;
}

export function safeAttachmentName(value: string): string {
	const basename = path
		.basename(value)
		.replace(/[\\/\\\\]/g, "_")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 100);
	return basename && basename !== "." && basename !== ".."
		? basename
		: "attachment";
}

export async function listDirectoryEntries(
	candidate: string,
): Promise<ListedDirectory> {
	const cwd = await resolveExistingDirectory(candidate);
	try {
		const allEntries = (await readdir(cwd, { withFileTypes: true }))
			.filter((entry) => !entry.name.startsWith("."))
			.sort((left, right) => left.name.localeCompare(right.name));
		const entries = await Promise.all(
			allEntries.slice(0, MAX_LIST_ENTRIES).map(async (entry) => {
				let kind: "directory" | "file" = entry.isDirectory()
					? "directory"
					: "file";
				if (entry.isSymbolicLink()) {
					try {
						if ((await stat(path.join(cwd, entry.name))).isDirectory())
							kind = "directory";
					} catch {
						/* Unresolvable links remain visible as files. */
					}
				}
				return { name: entry.name, kind };
			}),
		);
		return {
			cwd,
			entries,
			total: allEntries.length,
			truncated: allEntries.length > MAX_LIST_ENTRIES,
		};
	} catch {
		throw new DirectoryResolutionError();
	}
}
