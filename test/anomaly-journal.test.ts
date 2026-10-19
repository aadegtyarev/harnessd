import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnomalyJournal } from "../src/core/anomaly-journal.js";
import type {
	HarnessAdapter,
	HarnessAnomaly,
	HarnessEvent,
	SessionId,
} from "../src/core/index.js";
import { SessionManager, SqliteSessionStore } from "../src/core/index.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const sid = "s1" as SessionId;
const oversized: HarnessAnomaly = {
	kind: "oversized_record",
	action: "handled",
	harnessRunning: true,
	ref: "abcd1234",
	recordType: "agent_end",
	bytes: 5_242_880,
};

describe("AnomalyJournal", () => {
	it("writes one single-line harnessd entry with kind, type, size and ref", () => {
		const lines: string[] = [];
		new AnomalyJournal((line) => lines.push(line)).record(sid, oversized);
		expect(lines).toEqual([
			"harnessd: session s1 harness_anomaly kind=oversized_record action=handled running=yes ref=abcd1234 type=agent_end bytes=5242880",
		]);
	});

	it("quotes heads, details and odd tokens so each entry stays one line", () => {
		const lines: string[] = [];
		new AnomalyJournal((line) => lines.push(line)).record(sid, {
			kind: "invalid_json",
			action: "skipped",
			harnessRunning: true,
			ref: "r1",
			command: "bad command\nname",
			head: 'line\nwith "quotes"',
			detail: "detail",
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
		expect(lines[0]).toContain('command="bad command\\nname"');
		expect(lines[0]).toContain(
			'detail="detail" head="line\\nwith \\"quotes\\""',
		);
	});

	it("journals every occurrence but limits floods per session and kind", () => {
		let now = 0;
		const lines: string[] = [];
		const journal = new AnomalyJournal(
			(line) => lines.push(line),
			() => now,
		);
		for (let index = 0; index < 35; index++) journal.record(sid, oversized);
		journal.record(sid, { ...oversized, kind: "invalid_json" });
		journal.record("s2" as SessionId, oversized);
		expect(lines).toHaveLength(32);
		now = 60_000;
		journal.record(sid, oversized);
		expect(lines.at(-1)).toContain("suppressed=5");
	});
});

describe("SessionManager anomaly events", () => {
	it("journals a harness anomaly and still forwards it to observers", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "anomaly-"));
		directories.push(directory);
		const store = await SqliteSessionStore.open(directory);
		const journal: string[] = [];
		const harness: HarnessAdapter = {
			descriptor: {
				id: "fake" as never,
				capabilities: ["harness.launch", "harness.stop"],
			},
			async launch(request) {
				return {
					processId: "p" as never,
					exit: new Promise(() => {}),
					events: (async function* () {
						yield {
							sessionId: request.sessionId,
							kind: "anomaly",
							anomalyEvent: oversized,
						} satisfies HarnessEvent;
					})(),
					async send() {},
					async cancel() {},
					async shutdown() {},
				};
			},
		};
		const manager = new SessionManager(store, [harness], {
			journal: (line) => journal.push(line),
		});
		const seen: HarnessEvent[] = [];
		manager.subscribe((event) => {
			seen.push(event);
		});
		const session = await manager.create({
			harnessId: harness.descriptor.id,
			cwd: directory,
		});
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]?.anomalyEvent).toEqual(oversized);
		expect(journal).toEqual([
			expect.stringMatching(
				new RegExp(
					`^harnessd: session ${session.id} harness_anomaly kind=oversized_record `,
				),
			),
		]);
		await manager.close();
		store.close();
	});
});
