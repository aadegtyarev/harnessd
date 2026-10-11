import { describe, expect, it } from "vitest";
import {
	type AgentSnapshot,
	agentVerdicts,
	latestAgentSnapshot,
	renderAgentBoard,
} from "../src/telegram-agent-board.js";

const envelope = (runs: unknown[], omitted?: unknown) =>
	`Pi: PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
		kind: "pi-subagents.async-status-snapshot",
		runs,
		...(omitted ? { omitted } : {}),
	})}`;
const snapshot = (runs: unknown[], omitted?: unknown): AgentSnapshot =>
	latestAgentSnapshot(envelope(runs, omitted)) ?? { runs: [], omitted: 0 };
const minute = 60_000;

describe("agent board", () => {
	it("shows one row per parallel run, steps under their run, and the wait target", () => {
		const board = renderAgentBoard(
			snapshot([
				{
					id: "a6ff0d6b-cab9",
					kind: "subagent",
					label: "worker",
					state: "running",
					startedAt: 0,
					activity: { currentTool: "bash", toolCount: 37 },
				},
				{
					id: "b7120000-0000",
					kind: "subagent",
					label: "worker",
					state: "running",
					startedAt: 5 * minute,
					activity: { state: "needs_attention" },
				},
				{
					id: "9c1d0000-0000",
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
			11 * minute,
			{ waitingFor: ["worker #a6ff0d6b"] },
		);
		expect(board).toEqual([
			"🤖 Агенты · 3 работают параллельно",
			"❓ worker #b7120000 · 6м · спрашивает родителя",
			"🟢 worker #a6ff0d6b · 11м · bash · 37 выз.",
			"🟢 review-loop #9c1d0000 · 11м",
			"   ↳ ⏳ reviewer",
			"   ↳ ✅ worker",
			"⏸ родитель ждёт: worker #a6ff0d6b",
		]);
	});

	it("never cuts a step that asks the parent and counts every hidden row", () => {
		const steps = Array.from({ length: 7 }, (_, index) => ({
			id: `s${index}`,
			kind: "step",
			label: `step-${index}`,
			state: index === 6 ? "running" : "complete",
			...(index === 6 ? { activity: { state: "needs_attention" } } : {}),
			startedAt: index,
			endedAt: index === 6 ? undefined : index + 1,
		}));
		const board = renderAgentBoard(
			snapshot(
				[
					{
						id: "abcdef12-0",
						kind: "workflow",
						label: "chain",
						state: "running",
						children: steps,
					},
				],
				{ runs: 2, children: 1 },
			),
			100,
		);
		expect(board[2]).toBe("   ↳ ❓ step-6 · <1м · спрашивает родителя");
		expect(board).toHaveLength(8);
		expect(board.at(-1)).toBe("… ещё 5");
	});

	it("pairs verdicts with repeated, parallel, and grouped runs of the same agent", () => {
		const runs = snapshot([
			{
				id: "11111111-a",
				kind: "subagent",
				label: "reviewer",
				state: "complete",
				startedAt: 0,
				endedAt: 10,
			},
			{
				id: "22222222-b",
				kind: "subagent",
				label: "reviewer",
				state: "complete",
				startedAt: 0,
				endedAt: 20,
			},
			{
				id: "33333333-c",
				kind: "subagent",
				label: "reviewer, reviewer",
				state: "complete",
				startedAt: 0,
				endedAt: 30,
			},
		]);
		const verdicts = [
			...agentVerdicts(
				"Background task completed: **reviewer**\n\n## Review\n\n**REQUEST_CHANGES**\n\n- **P1 — first run**",
			),
			...agentVerdicts(
				"Background task completed: **reviewer**\n\n## Review\n\n**APPROVE**",
			),
			...agentVerdicts(
				"Background tasks completed (2): **reviewer**, **worker**\n\n1. reviewer\n## Reviewer verdict\nNot APPROVED yet: **REQUEST_CHANGES**\n2. worker\nDone.",
			),
		];
		expect(verdicts.map(({ agent, verdict }) => `${agent}:${verdict}`)).toEqual(
			[
				"reviewer:REQUEST_CHANGES",
				"reviewer:APPROVE",
				"reviewer:REQUEST_CHANGES",
				"worker:готово",
			],
		);
		const text = renderAgentBoard(runs, 100, { verdicts }).join("\n");
		expect(text).toContain(
			"✅ reviewer, reviewer #33333333 · <1м · REQUEST_CHANGES",
		);
		expect(text).toContain("✅ reviewer #22222222 · <1м · APPROVE");
		expect(text).toContain(
			"✅ reviewer #11111111 · <1м · REQUEST_CHANGES: P1 — first run",
		);
		expect(agentVerdicts("Background task failed: **worker**")).toEqual([
			{ agent: "worker", verdict: "ошибка" },
		]);
	});

	it("bounds the wait line, waits for all without IDs, and hides old finished runs", () => {
		const runs = snapshot(
			["a", "b", "c", "d"].map((letter, index) => ({
				id: `${letter.repeat(8)}-0`,
				kind: "subagent",
				label: `agent-${letter}`,
				state: "running",
				startedAt: index,
			})),
		);
		expect(renderAgentBoard(runs, 10, { waitsForAll: true }).at(-1)).toBe(
			"⏸ родитель ждёт: agent-d #dddddddd, agent-c #cccccccc, agent-b #bbbbbbbb и ещё 1",
		);
		const old = snapshot([
			{
				id: "eeeeeeee-0",
				kind: "subagent",
				label: "scout",
				state: "complete",
				startedAt: 0,
				endedAt: 5,
			},
		]);
		expect(renderAgentBoard(old, 100, { finishedSince: 50 })).toEqual([]);
		expect(renderAgentBoard(old, 100, { finishedSince: 1 })).toHaveLength(2);
	});

	it("ignores malformed or foreign envelopes and odd IDs", () => {
		expect(latestAgentSnapshot("plain text")).toBeUndefined();
		expect(
			latestAgentSnapshot("PI_SUBAGENT_ASYNC_JSON:{bad json"),
		).toBeUndefined();
		expect(
			latestAgentSnapshot('PI_SUBAGENT_ASYNC_JSON:{"kind":"other","runs":[]}'),
		).toBeUndefined();
		expect(agentVerdicts("Something else")).toEqual([]);
		const board = renderAgentBoard(
			snapshot([
				{
					id: "PRIVATE_ID",
					kind: "subagent",
					label: "worker",
					state: "running",
				},
				{ id: "--------", kind: "subagent", label: "scout", state: "running" },
			]),
			0,
		).join("\n");
		expect(board).not.toContain("PRIVATE");
		expect(board).not.toContain("#--------");
	});
});
