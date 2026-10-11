import { describe, expect, it } from "vitest";
import {
	agentVerdict,
	latestAgentSnapshot,
	renderAgentBoard,
} from "../src/telegram-agent-board.js";

const envelope = (runs: unknown[]) =>
	`Pi: PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
		kind: "pi-subagents.async-status-snapshot",
		runs,
	})}`;
const minute = 60_000;

describe("agent board", () => {
	it("shows one row per parallel run with activity, steps, and the wait target", () => {
		const runs =
			latestAgentSnapshot(
				envelope([
					{
						id: "a6ff0d6b-cab9-422d",
						kind: "subagent",
						label: "worker",
						state: "running",
						startedAt: 0,
						activity: { currentTool: "bash", toolCount: 37 },
					},
					{
						id: "b7120000-0000-0000",
						kind: "subagent",
						label: "worker",
						state: "running",
						startedAt: 5 * minute,
						activity: { state: "needs_attention" },
					},
					{
						id: "9c1d0000-0000-0000",
						kind: "workflow",
						label: "review-loop",
						state: "running",
						startedAt: 0,
						children: [
							{ id: "s1", kind: "step", label: "worker", state: "complete" },
							{ id: "s2", kind: "step", label: "reviewer", state: "queued" },
						],
					},
				]),
			) ?? [];
		const lines = renderAgentBoard(runs, 11 * minute, new Map(), [
			"worker #a6ff0d6b",
		]);
		expect(lines).toEqual([
			"🤖 Агенты · 3 работают параллельно",
			"❓ worker #b7120000 · 6м · спрашивает родителя",
			"🟢 worker #a6ff0d6b · 11м · bash · 37 выз.",
			"🟢 review-loop #9c1d0000 · 11м",
			"   ↳ ✅ worker",
			"   ↳ ⏳ reviewer",
			"⏸ родитель ждёт: worker #a6ff0d6b",
		]);
	});

	it("caps rows, attaches a reviewer verdict to the latest finished run, and hides odd IDs", () => {
		const runs =
			latestAgentSnapshot(
				envelope([
					...Array.from({ length: 7 }, (_, index) => ({
						id: `0000000${index}-aaaa`,
						kind: "subagent",
						label: "scout",
						state: "complete",
						startedAt: index,
						endedAt: index + 1,
					})),
					{
						id: "24fee3a4-910f",
						kind: "subagent",
						label: "reviewer",
						state: "complete",
						startedAt: 0,
						endedAt: 100,
					},
					{
						id: "PRIVATE_ID",
						kind: "subagent",
						label: "worker",
						state: "failed",
					},
				]),
			) ?? [];
		const verdict = agentVerdict(
			"Background task completed: **reviewer**\n\nreviewer:\n## Review\n\n**REQUEST_CHANGES**\n\n- **P1 — backup получателя отвергается.** details",
		);
		expect(verdict).toEqual({
			agent: "reviewer",
			verdict: "REQUEST_CHANGES",
			finding: "P1 — backup получателя отвергается.",
		});
		const lines = renderAgentBoard(
			runs,
			200,
			new Map([["reviewer", verdict as NonNullable<typeof verdict>]]),
		);
		expect(lines).toHaveLength(8);
		expect(lines.join("\n")).toContain(
			"✅ reviewer #24fee3a4 · <1м · REQUEST_CHANGES: P1 — backup получателя отвергается.",
		);
		expect(lines.join("\n")).not.toContain("PRIVATE_ID");
		expect(lines.at(-1)).toBe("… ещё 3");
	});

	it("ignores malformed or foreign envelopes", () => {
		expect(latestAgentSnapshot("plain text")).toBeUndefined();
		expect(
			latestAgentSnapshot("PI_SUBAGENT_ASYNC_JSON:{bad json"),
		).toBeUndefined();
		expect(
			latestAgentSnapshot('PI_SUBAGENT_ASYNC_JSON:{"kind":"other","runs":[]}'),
		).toBeUndefined();
		expect(agentVerdict("Something else")).toBeUndefined();
		expect(
			agentVerdict("Background task completed: **worker**\n\nDone.")?.verdict,
		).toBe("готово");
	});
});
