import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DirectoryResolutionError,
	listDirectoryEntries,
	parsePathArgument,
	resolveExistingDirectory,
	resolveInitialDirectory,
	resolvePathFrom,
} from "../src/telegram-filesystem.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function temp(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "harnessd-filesystem-"));
	roots.push(root);
	return root;
}

describe("Telegram filesystem paths", () => {
	it("defaults to the system root and resolves configured relative folders", async () => {
		const root = await temp();
		const configured = path.join(root, "workspace");
		await mkdir(configured);

		await expect(resolveInitialDirectory(undefined, root)).resolves.toBe(
			path.parse(root).root,
		);
		await expect(resolveInitialDirectory("workspace", root)).resolves.toBe(
			configured,
		);
	});

	it("expands tilde to the OS user's home independently of HARNESSD_HOME", () => {
		expect(resolvePathFrom("~", "/var/tmp", "/home/test-user")).toBe(
			"/home/test-user",
		);
		expect(
			resolvePathFrom("~/project files", "/var/tmp", "/home/test-user"),
		).toBe("/home/test-user/project files");
		expect(resolvePathFrom("../other", "/var/tmp", "/home/test-user")).toBe(
			"/var/other",
		);
	});

	it("parses paths with spaces and requires matching outer quotes", () => {
		expect(parsePathArgument("folder with spaces")).toEqual({
			ok: true,
			path: "folder with spaces",
		});
		expect(parsePathArgument('"folder with spaces"')).toEqual({
			ok: true,
			path: "folder with spaces",
		});
		expect(parsePathArgument("'unmatched")).toEqual({ ok: false });
		expect(parsePathArgument('""')).toEqual({ ok: false });
		expect(parsePathArgument(undefined)).toEqual({ ok: true, path: undefined });
	});

	it("allows navigation through a symlink outside the initial folder", async () => {
		const root = await temp();
		const outside = path.join(root, "outside");
		const link = path.join(root, "link");
		await mkdir(outside);
		await symlink(outside, link);

		await expect(resolveExistingDirectory(link)).resolves.toBe(outside);
	});

	it("lists immediate visible entries, excluding dotfiles and bounding output", async () => {
		const root = await temp();
		await mkdir(path.join(root, "nested"));
		await symlink(path.join(root, "nested"), path.join(root, "linked-folder"));
		await writeFile(path.join(root, "visible.txt"), "not read");
		await writeFile(path.join(root, ".secret"), "not read");
		for (let index = 0; index < 97; index++)
			await writeFile(path.join(root, `entry-${index}.txt`), "");
		await writeFile(path.join(root, "zzz.txt"), "");

		const listing = await listDirectoryEntries(root);
		expect(listing.cwd).toBe(root);
		expect(listing.entries).toHaveLength(100);
		expect(listing.total).toBe(101);
		expect(
			listing.entries.find((entry) => entry.name === "linked-folder"),
		).toEqual({ name: "linked-folder", kind: "directory" });
		expect(listing.truncated).toBe(true);
		expect(listing.entries.some((entry) => entry.name === ".secret")).toBe(
			false,
		);
		expect(listing.entries.find((entry) => entry.name === "nested")).toEqual({
			name: "nested",
			kind: "directory",
		});
		expect(
			listing.entries.find((entry) => entry.name === "visible.txt"),
		).toEqual({ name: "visible.txt", kind: "file" });
	});

	it("rejects missing and non-directory paths with a safe error", async () => {
		const root = await temp();
		const file = path.join(root, "file");
		await writeFile(file, "");

		await expect(
			resolveExistingDirectory(path.join(root, "missing")),
		).rejects.toBeInstanceOf(DirectoryResolutionError);
		await expect(listDirectoryEntries(file)).rejects.toBeInstanceOf(
			DirectoryResolutionError,
		);
	});
});
