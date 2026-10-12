import { describe, expect, it } from "vitest";
import {
	bashExitDetail,
	coordinationSummary,
	subagentNotice,
	taskActivity,
	thoughtSummary,
} from "../src/harness/pi-activity-details.js";
import { agentVerdicts } from "../src/telegram-agent-board.js";

describe("Pi activity details", () => {
	it("reduces thinking to the last summary title or the first sentence", () => {
		expect(thoughtSummary("**Planning async scout launch**")).toBe(
			"Planning async scout launch",
		);
		expect(
			thoughtSummary(
				"**Proposing chat-surface relocation**\n\n**Planning docs cleanup**",
			),
		).toBe("Planning docs cleanup");
		expect(
			thoughtSummary(
				"I need to check the config first. Then I will run the tests and compare.",
			),
		).toBe("I need to check the config first.");
		expect(thoughtSummary("")).toBeUndefined();
		expect([...(thoughtSummary("x".repeat(500)) ?? "")].length).toBe(120);
		expect(thoughtSummary("**Retry with password=hunter2 now**")).not.toContain(
			"hunter2",
		);
	});

	it("reads bash exit codes from Pi results", () => {
		const result = (text: string) => ({ content: [{ type: "text", text }] });
		expect(bashExitDetail(result("ok"), false)).toBe("exit 0");
		expect(
			bashExitDetail(result("boom\nCommand exited with code 2"), true),
		).toBe("exit 2");
		expect(bashExitDetail(undefined, true)).toBe("error");
	});

	it("extracts /task state from appended entries only", () => {
		expect(
			taskActivity({
				type: "custom",
				customType: "pi-ad-hooks-task",
				data: {
					goal: "Ship v0.25.0",
					progress: "Worker fixes the recipient backup",
					status: "active",
					continuations: 7,
					continuationLimit: 40,
				},
			}),
		).toEqual({
			type: "task",
			goal: "Ship v0.25.0",
			progress: "Worker fixes the recipient backup",
			status: "active",
			step: 7,
			limit: 40,
		});
		expect(taskActivity({ customType: "other", data: {} })).toBeUndefined();
		expect(taskActivity(undefined)).toBeUndefined();
	});

	it("describes subagent coordination in plain language", () => {
		expect(
			coordinationSummary("bg_wait", {
				id: "a6ff0d6b-cab9",
				timeoutMs: 600_000,
			}),
		).toBe("⏸ ждёт агентов #a6ff0d6b (до 10 мин)");
		expect(coordinationSummary("bg_wait", {})).toBe("⏸ ждёт агентов");
		expect(
			coordinationSummary("subagent", { action: "steer", id: "506f248d-490e" }),
		).toBe("📨 отправил указание агенту #506f248d");
		expect(
			coordinationSummary("subagent", { agent: "worker" }),
		).toBeUndefined();
		expect(coordinationSummary("read", {})).toBeUndefined();
	});

	it("forwards only subagent completion notices", () => {
		expect(
			subagentNotice({
				role: "custom",
				customType: "subagent-notify",
				content: "Background task completed: **reviewer** password=hunter2",
			}),
		).toBe("Background task completed: **reviewer** password=[REDACTED]");
		expect(
			subagentNotice({ role: "custom", customType: "other", content: "x" }),
		).toBeUndefined();
		expect(subagentNotice({ role: "assistant", content: "x" })).toBeUndefined();
	});

	it("keeps run-ID lines that a long notice preview pushes past the limit", () => {
		const long = "x".repeat(5_000);
		const notice = subagentNotice({
			role: "custom",
			customType: "subagent-notify",
			content: `Background tasks completed (2): **reviewer**, **worker**\n\n1. reviewer\n${long}\nRetention-managed async directory: /a/11111111-a\n\n2. worker\n${long}\nRetention-managed async directory: /a/22222222-b`,
		});
		expect(notice?.length).toBeLessThan(4_300);
		expect(agentVerdicts(notice ?? "").map((verdict) => verdict.runId)).toEqual(
			["11111111-a", "22222222-b"],
		);
	});
});
