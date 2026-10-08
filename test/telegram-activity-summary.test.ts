import { describe, expect, it } from "vitest";
import { meaningfulToolSummary } from "../src/telegram-activity-projection.js";

describe("Telegram activity summary filtering", () => {
	it("suppresses generic workflow and subagent management plumbing", () => {
		expect(meaningfulToolSummary("subagent · workflow · inspect")).toBe(false);
		expect(meaningfulToolSummary("subagent_wait: worker")).toBe(false);
		expect(meaningfulToolSummary("bash: npm test")).toBe(true);
	});

	it("accepts only approved subagent role labels", () => {
		expect(meaningfulToolSummary("subagent · worker · task text")).toBe(true);
		expect(meaningfulToolSummary("subagent · manager · task text")).toBe(false);
	});
});
