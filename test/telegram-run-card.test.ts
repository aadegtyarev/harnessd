import { describe, expect, it } from "vitest";
import {
	addThoughtEvent,
	addToolEvent,
	finishToolEvent,
	formatDuration,
	formatRunCardEvent,
	RUN_CARD_EVENT_HISTORY,
	type RunCardEvent,
	renderRunCard,
	runCardStateIcon,
} from "../src/telegram-run-card.js";

describe("run card", () => {
	it("collapses consecutive reads but keeps bash calls separate", () => {
		const events: RunCardEvent[] = [];
		addToolEvent(events, "r1", "read: a.ts", "10:00", 0);
		finishToolEvent(events, "r1", false, undefined, 10);
		addToolEvent(events, "r2", "read: b.ts", "10:01", 20);
		finishToolEvent(events, "r2", false, undefined, 30);
		addToolEvent(events, "b1", "bash: npm test", "10:02", 0);
		finishToolEvent(events, "b1", false, "exit 0", 4_000);
		addToolEvent(events, "b2", "bash: npm run lint", "10:03", 0);
		expect(events.map(formatRunCardEvent)).toEqual([
			"10:01 📖 2× b.ts ✓",
			"10:02 $ npm test → 0 · 4с",
			"10:03 $ npm run lint …",
		]);
		expect(addToolEvent(events, "b2", "bash: npm run lint", "10:04", 0)).toBe(
			false,
		);
	});

	it("bounds history and skips repeated thoughts", () => {
		const events: RunCardEvent[] = [];
		for (let index = 0; index < RUN_CARD_EVENT_HISTORY + 5; index++)
			addToolEvent(events, `b${index}`, `bash: step ${index}`, "10:00", 0);
		expect(events).toHaveLength(RUN_CARD_EVENT_HISTORY);
		addThoughtEvent(events, "Planning", "10:05");
		addThoughtEvent(events, "Planning", "10:05");
		expect(events.filter((event) => event.kind === "thought")).toHaveLength(1);
	});

	it("formats durations and header state", () => {
		expect(formatDuration(42_000)).toBe("42с");
		expect(formatDuration(125_000)).toBe("2м 5с");
		expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2ч 14м");
		const waiting: RunCardEvent[] = [];
		addToolEvent(waiting, "w", "⏸ ждёт агентов #a6ff", "10:00", 0);
		expect(runCardStateIcon({ events: waiting })).toBe("⏸");
		expect(
			runCardStateIcon({
				events: [],
				task: { goal: "g", status: "blocked", step: 1 },
			}),
		).toBe("❓");
		expect(runCardStateIcon({ events: [], finished: "done" })).toBe("✅");
		const card = renderRunCard({
			stateIcon: "⏳",
			status: "работает",
			sessionLabel: "open-webdav · #45fc90f9",
			elapsedMs: 72 * 60_000 + 30_000,
			notices: [],
			events: waiting,
			footer: "usage",
		});
		expect(card.split("\n")[0]).toBe(
			"⏳ Ход · работает · open-webdav · #45fc90f9 · 1ч 12м",
		);
		expect(card).toContain("🕘 События");
	});
});
