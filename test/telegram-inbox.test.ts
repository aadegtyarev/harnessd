import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionId, SessionSummary } from "../src/core/types.js";
import {
	TELEGRAM_INBOX_MAX_BYTES_PER_SESSION,
	TELEGRAM_INBOX_MAX_FILE_BYTES,
	TELEGRAM_INBOX_TTL_MS,
	TelegramInbox,
	TelegramInboxError,
} from "../src/telegram-inbox.js";

const roots: string[] = [];
async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "harnessd-inbox-"));
	roots.push(directory);
	return directory;
}
function session(id = "sid", status: SessionSummary["status"] = "stopped") {
	return {
		id: id as SessionId,
		cwd: "/workspace",
		harnessId: "pi-rpc" as never,
		status,
	} satisfies SessionSummary;
}

afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("TelegramInbox", () => {
	it("saves private collision-resistant files below the state inbox", async () => {
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory);
		const saved = await inbox.save(
			"sid" as SessionId,
			"../../private note.txt",
			Buffer.from("secret"),
		);
		expect(saved.path).toContain(path.join(stateDirectory, "inbox", "sid"));
		expect(path.basename(saved.path)).toMatch(/^\d{13}-[a-f0-9]{16}-/);
		expect(await readFile(saved.path, "utf8")).toBe("secret");
		expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
		expect((await stat(path.dirname(saved.path))).mode & 0o777).toBe(0o700);
	});

	it("refuses to create an inbox inside the session workspace", async () => {
		const workspace = await temporaryDirectory();
		const inbox = new TelegramInbox(workspace);
		await expect(
			inbox.save(
				"sid" as SessionId,
				"incoming.txt",
				Buffer.from("data"),
				false,
				workspace,
			),
		).rejects.toBeInstanceOf(TelegramInboxError);
		expect(await readdir(workspace)).toEqual([]);
	});

	it("refuses an inbox destination that is exactly the session workspace", async () => {
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory);
		const workspace = path.join(stateDirectory, "inbox", "sid");
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		await expect(
			inbox.save(
				"sid" as SessionId,
				"incoming.txt",
				Buffer.from("data"),
				false,
				workspace,
			),
		).rejects.toBeInstanceOf(TelegramInboxError);
		expect(await readdir(workspace)).toEqual([]);
	});

	it("rejects an oversized file, keeps any number of small files, and evicts the oldest to fit the byte limit", async () => {
		const inbox = new TelegramInbox(await temporaryDirectory());
		await expect(
			inbox.save(
				"sid" as SessionId,
				"oversized.bin",
				Buffer.alloc(TELEGRAM_INBOX_MAX_FILE_BYTES + 1),
			),
		).rejects.toThrow("Telegram inbox operation failed");
		const stored = [];
		for (let index = 0; index < 30; index++)
			stored.push(
				await inbox.save("sid" as SessionId, `${index}.txt`, Buffer.from("x")),
			);
		for (const file of stored)
			expect(await readFile(file.path, "utf8")).toBe("x");

		const stateDirectory = await temporaryDirectory();
		const byteInbox = new TelegramInbox(stateDirectory);
		const directory = path.join(stateDirectory, "inbox", "sid");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const filler = path.join(
			directory,
			"0000000000000-aaaaaaaaaaaaaaaa-filler.bin",
		);
		await writeFile(
			filler,
			Buffer.alloc(TELEGRAM_INBOX_MAX_BYTES_PER_SESSION - 1),
			{ mode: 0o600 },
		);
		const recent = path.join(
			directory,
			"0000000000001-bbbbbbbbbbbbbbbb-recent.bin",
		);
		await writeFile(recent, "x", { mode: 0o600 });
		await byteInbox.save("sid" as SessionId, "extra.txt", Buffer.from("x"));
		expect(await readdir(directory)).toHaveLength(2);
		await expect(stat(filler)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(recent, "utf8")).toBe("x");
	});

	it("never evicts files it did not name, and evicts nothing when the upload cannot fit", async () => {
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory);
		const directory = path.join(stateDirectory, "inbox", "sid");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(
			path.join(directory, "0000000000000-aaaaaaaaaaaaaaaa-named.txt"),
			"x",
			{ mode: 0o600 },
		);
		await writeFile(
			path.join(directory, "foreign"),
			Buffer.alloc(TELEGRAM_INBOX_MAX_BYTES_PER_SESSION),
			{ mode: 0o600 },
		);
		await expect(
			inbox.save("sid" as SessionId, "new.txt", Buffer.from("y")),
		).rejects.toBeInstanceOf(TelegramInboxError);
		expect((await readdir(directory)).sort()).toEqual([
			"0000000000000-aaaaaaaaaaaaaaaa-named.txt",
			"foreign",
		]);
	});

	it("expires files only after the session is terminal and removes deleted-session inboxes", async () => {
		let now = 1_800_000_000_000;
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory, () => now);
		const saved = await inbox.save(
			"sid" as SessionId,
			"file.dat",
			Buffer.from("data"),
		);
		now += TELEGRAM_INBOX_TTL_MS + 1;
		await inbox.sweep([session("sid", "stopped")], async () => [
			session("sid", "running"),
		]);
		expect(await readFile(saved.path, "utf8")).toBe("data");
		await inbox.sweep([session("sid", "stopped")], async () => [
			session("sid", "stopped"),
		]);
		await expect(readFile(saved.path)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await inbox.save("sid" as SessionId, "other.dat", Buffer.from("data"));
		await inbox.sweep([]);
		await expect(readdir(path.dirname(saved.path))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("preserves expired files when resume races with a queued cleanup", async () => {
		let now = 1_800_000_000_000;
		const inbox = new TelegramInbox(await temporaryDirectory(), () => now);
		const saved = await inbox.save(
			"sid" as SessionId,
			"file.dat",
			Buffer.from("data"),
		);
		now += TELEGRAM_INBOX_TTL_MS + 1;
		let announceResume!: () => void;
		let releaseResume!: () => void;
		const resumeStarted = new Promise<void>((resolve) => {
			announceResume = resolve;
		});
		const resumeGate = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		let currentSession = session("sid", "stopped");
		const resume = inbox.withSessionLock("sid" as SessionId, async () => {
			currentSession = session("sid", "running");
			announceResume();
			await resumeGate;
		});
		await resumeStarted;
		const cleanup = inbox.sweep([session("sid", "stopped")], async () => [
			currentSession,
		]);
		releaseResume();
		await Promise.all([resume, cleanup]);
		await expect(readFile(saved.path, "utf8")).resolves.toBe("data");
	});

	it("serializes an in-flight upload with session deletion", async () => {
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory);
		let startUpload!: () => void;
		let releaseUpload!: () => void;
		const uploadStarted = new Promise<void>((resolve) => {
			startUpload = resolve;
		});
		const uploadGate = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		const upload = inbox.withSessionLock("sid" as SessionId, async () => {
			startUpload();
			await uploadGate;
			await inbox.saveUnderLock(
				"sid" as SessionId,
				"upload.txt",
				Buffer.from("data"),
			);
		});
		await uploadStarted;
		const deletion = inbox.withSessionLock("sid" as SessionId, async () =>
			inbox.removeSessionUnderLock("sid" as SessionId),
		);
		releaseUpload();
		await Promise.all([upload, deletion]);
		await expect(
			readdir(path.join(stateDirectory, "inbox", "sid")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes concurrent saves and rejects an inbox symlink", async () => {
		const stateDirectory = await temporaryDirectory();
		const inbox = new TelegramInbox(stateDirectory);
		const concurrent = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				inbox.save("sid" as SessionId, `${index}.dat`, Buffer.from("x")),
			),
		);
		expect(concurrent).toHaveLength(10);
		await inbox.save("sid" as SessionId, "eleventh.dat", Buffer.from("x"));
		expect(
			await readdir(path.join(stateDirectory, "inbox", "sid")),
		).toHaveLength(11);

		const outside = path.join(stateDirectory, "outside");
		await mkdir(outside);
		const maliciousRoot = path.join(stateDirectory, "malicious");
		await mkdir(maliciousRoot);
		await symlink(outside, path.join(maliciousRoot, "inbox"));
		const unsafeInbox = new TelegramInbox(maliciousRoot);
		await expect(
			unsafeInbox.save("sid" as SessionId, "escape.txt", Buffer.from("x")),
		).rejects.toThrow("Telegram inbox operation failed");
		expect(await readdir(outside)).toEqual([]);
	});

	it.each(["root", "session"] as const)(
		"refuses to remove stale files through a substituted %s symlink",
		async (substitution) => {
			const stateDirectory = await temporaryDirectory();
			const outside = path.join(stateDirectory, "outside");
			await mkdir(outside, { mode: 0o700 });
			const filename = "1800000000000-aaaaaaaaaaaaaaaa-private.txt";
			const outsideFile = path.join(outside, filename);
			await writeFile(outsideFile, "must remain", { mode: 0o600 });
			const inboxRoot = path.join(stateDirectory, "inbox");
			if (substitution === "root") await symlink(outside, inboxRoot);
			else {
				await mkdir(inboxRoot, { mode: 0o700 });
				await symlink(outside, path.join(inboxRoot, "sid"));
			}
			const inbox = new TelegramInbox(stateDirectory);
			await expect(
				inbox.withSessionLock("sid" as SessionId, () =>
					inbox.removeSavedAttachmentUnderLock("sid" as SessionId, outsideFile),
				),
			).rejects.toBeInstanceOf(TelegramInboxError);
			expect(await readFile(outsideFile, "utf8")).toBe("must remain");
		},
	);

	it.each(["root", "session"] as const)(
		"requires private inbox %s directories before stale-file removal",
		async (nonPrivateDirectory) => {
			const stateDirectory = await temporaryDirectory();
			const inboxRoot = path.join(stateDirectory, "inbox");
			const sessionDirectory = path.join(inboxRoot, "sid");
			await mkdir(
				nonPrivateDirectory === "root" ? inboxRoot : sessionDirectory,
				{ recursive: true, mode: 0o755 },
			);
			if (nonPrivateDirectory === "root")
				await mkdir(sessionDirectory, { mode: 0o700 });
			const staleFile = path.join(
				sessionDirectory,
				"1800000000000-bbbbbbbbbbbbbbbb-private.txt",
			);
			await writeFile(staleFile, "must remain", { mode: 0o600 });
			const inbox = new TelegramInbox(stateDirectory);
			await expect(
				inbox.withSessionLock("sid" as SessionId, () =>
					inbox.removeSavedAttachmentUnderLock("sid" as SessionId, staleFile),
				),
			).rejects.toBeInstanceOf(TelegramInboxError);
			expect(await readFile(staleFile, "utf8")).toBe("must remain");
		},
	);

	it("removes a saved stale attachment only from its validated inbox", async () => {
		const inbox = new TelegramInbox(await temporaryDirectory());
		const saved = await inbox.save(
			"sid" as SessionId,
			"stale.txt",
			Buffer.from("discard me"),
		);
		await inbox.withSessionLock("sid" as SessionId, () =>
			inbox.removeSavedAttachmentUnderLock("sid" as SessionId, saved.path),
		);
		await expect(readFile(saved.path)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
