import { describe, expect, it } from "vitest";
import { AGENT_FILE_SEND_TOKEN_ENV } from "../src/harness/agent-file-send-protocol.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude send_file launch configuration", () => {
	it("configures only send_file with fresh per-launch credentials", async () => {
		const first = fakeProvider();
		const send = async () => ({
			fileName: "a.txt",
			delivered: 1,
			recipients: 1,
		});
		const adapter = new ClaudeCodeHarnessAdapter(first.provider, {
			executable: "claude",
			agentFileSend: send,
		});
		expect(adapter.descriptor.capabilities).toContain("harness.file.send");
		const instance = await adapter.launch(launchRequest);
		const args = first.args() ?? [];
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("mcp__harnessd__send_file");
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		expect(Object.keys(config.mcpServers)).toEqual(["harnessd"]);
		const token = config.mcpServers.harnessd.env[AGENT_FILE_SEND_TOKEN_ENV];
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		await instance.shutdown();
		const second = fakeProvider();
		const other = await new ClaudeCodeHarnessAdapter(second.provider, {
			executable: "claude",
			agentFileSend: send,
		}).launch(launchRequest);
		const secondConfig = JSON.parse(
			(second.args() ?? [])[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as typeof config;
		expect(
			secondConfig.mcpServers.harnessd.env[AGENT_FILE_SEND_TOKEN_ENV],
		).not.toBe(token);
		await other.shutdown();
	});

	it("omits the MCP config and capability when handler is absent", async () => {
		const fake = fakeProvider();
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
		});
		expect(adapter.descriptor.capabilities).not.toContain("harness.file.send");
		const instance = await adapter.launch(launchRequest);
		expect(fake.args()).not.toContain("--mcp-config");
		await instance.shutdown();
	});
});
