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

	it("pairs verdicts with runs by the run ID each notice carries", () => {
		const finished = (id: string, label: string, endedAt: number) => ({
			id,
			kind: "subagent",
			label,
			state: "complete",
			startedAt: 0,
			endedAt,
		});
		const runs = snapshot([
			finished("11111111-a", "reviewer", 10),
			finished("22222222-b", "reviewer", 20),
			finished("33333333-c", "reviewer", 30),
			finished("44444444-d", "worker", 40),
		]);
		const dir = (id: string) =>
			`Retention-managed async directory: /home/u/.pi/async/${id}`;
		const verdicts = [
			// Arrives last but belongs to the oldest run.
			...agentVerdicts(
				`Background tasks completed (2): **reviewer**, **worker**\n\n1. reviewer\n## Reviewer verdict\n**REQUEST_CHANGES**\n\n1. Fix the parser\n2. worker is fine\n${dir("33333333-c")}\n\n2. worker\nDone.\n${dir("44444444-d")}`,
			),
			...agentVerdicts(
				`Background task completed: **reviewer**\n\n## Review\n\n**APPROVE**\n\n${dir("22222222-b")}`,
			),
			...agentVerdicts(
				`Background task completed: **reviewer**\n\n## Review\n\n**REQUEST_CHANGES**\n\n- **P1 — first run**\n\n${dir("11111111-a")}`,
			),
		];
		expect(
			verdicts.map(
				({ agent, runId, verdict }) => `${agent}:${runId}:${verdict}`,
			),
		).toEqual([
			"reviewer:33333333-c:REQUEST_CHANGES",
			"worker:44444444-d:готово",
			"reviewer:22222222-b:APPROVE",
			"reviewer:11111111-a:REQUEST_CHANGES",
		]);
		const text = renderAgentBoard(runs, 100, { verdicts }).join("\n");
		expect(text).toContain("✅ reviewer #33333333 · <1м · REQUEST_CHANGES");
		expect(text).toContain("✅ reviewer #22222222 · <1м · APPROVE");
		expect(text).toContain(
			"✅ reviewer #11111111 · <1м · REQUEST_CHANGES: P1 — first run",
		);
		expect(
			agentVerdicts(
				"Background task failed: **worker**\n\nboom\n\nWorkflow run: wf-1",
			),
		).toEqual([{ agent: "worker", runId: "wf-1", verdict: "ошибка" }]);
	});

	it("shows no verdict when a notice without an ID is ambiguous", () => {
		const runs = snapshot(
			["11111111-a", "22222222-b"].map((id, index) => ({
				id,
				kind: "subagent",
				label: "reviewer",
				state: "complete",
				startedAt: 0,
				endedAt: index + 1,
			})),
		);
		const verdicts = agentVerdicts(
			"Background task completed: **reviewer**\n\n## Review\n**APPROVE**",
		);
		expect(renderAgentBoard(runs, 100, { verdicts }).join("\n")).not.toContain(
			"APPROVE",
		);
		const one = snapshot([
			{
				id: "11111111-a",
				kind: "subagent",
				label: "reviewer",
				state: "complete",
				startedAt: 0,
				endedAt: 1,
			},
		]);
		expect(renderAgentBoard(one, 100, { verdicts }).join("\n")).toContain(
			"✅ reviewer #11111111 · <1м · APPROVE",
		);
	});

	it("marks a run whose cut step asks the parent", () => {
		const runs = snapshot(
			Array.from({ length: 6 }, (_, index) => ({
				id: `${index}`.repeat(8),
				kind: index === 0 ? "workflow" : "subagent",
				label: index === 0 ? "review-loop" : `agent-${index}`,
				state: "running",
				startedAt: index,
				...(index === 0
					? {
							children: [
								{
									id: "s1",
									kind: "step",
									label: "reviewer",
									state: "running",
									activity: { state: "needs_attention" },
								},
							],
						}
					: {}),
			})),
		);
		const board = renderAgentBoard(runs, 10);
		expect(board[1]).toBe(
			"❓ review-loop #00000000 · <1м · reviewer спрашивает родителя",
		);
		expect(board.at(-1)).toBe("… ещё 1");
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
