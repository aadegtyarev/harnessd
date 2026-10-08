import { describe, expect, it } from "vitest";
import { AGENT_FILE_SEND_URL_ENV } from "../src/harness/agent-file-send-protocol.js";
import { ClaudeCodeHarnessAdapter } from "../src/harness/claude-code-harness.js";
import { fakeProvider, launchRequest } from "./claude-code-fake.js";

describe("Claude send_file bridge lifecycle", () => {
	it("closes bridge when process startup fails", async () => {
		const fake = fakeProvider();
		let args: readonly string[] = [];
		fake.provider.launch = async (request) => {
			args = request.args;
			throw new Error("launch failed");
		};
		const adapter = new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "x",
				delivered: 1,
				recipients: 1,
			}),
		});
		await expect(adapter.launch(launchRequest)).rejects.toThrow(
			"launch failed",
		);
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		await expect(
			fetch(config.mcpServers.harnessd.env[AGENT_FILE_SEND_URL_ENV] ?? ""),
		).rejects.toThrow();
	});

	it("closes bridge while preserving failed process shutdown", async () => {
		const fake = fakeProvider({ ignoreTerm: true, rejectKill: true });
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "x",
				delivered: 1,
				recipients: 1,
			}),
		}).launch(launchRequest);
		const args = fake.args() ?? [];
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		const url = config.mcpServers.harnessd.env[AGENT_FILE_SEND_URL_ENV] ?? "";
		await expect(instance.shutdown()).rejects.toThrow("Claude shutdown failed");
		await expect(fetch(url)).rejects.toThrow();
		fake.finish();
	});

	it("closes bridge when process exits", async () => {
		const fake = fakeProvider();
		const instance = await new ClaudeCodeHarnessAdapter(fake.provider, {
			executable: "claude",
			agentFileSend: async () => ({
				fileName: "x",
				delivered: 1,
				recipients: 1,
			}),
		}).launch(launchRequest);
		const args = fake.args() ?? [];
		const config = JSON.parse(
			args[args.indexOf("--mcp-config") + 1] ?? "{}",
		) as { mcpServers: { harnessd: { env: Record<string, string> } } };
		fake.finish();
		await fake.process.exit;
		await new Promise((resolve) => setImmediate(resolve));
		await expect(
			fetch(config.mcpServers.harnessd.env[AGENT_FILE_SEND_URL_ENV] ?? ""),
		).rejects.toThrow();
		await instance.shutdown();
	});
});
