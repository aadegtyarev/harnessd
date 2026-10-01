import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import type {
	ManagedProcess,
	ProcessLaunchRequest,
	ProcessProvider,
} from "../core/ports.js";
import type { AdapterId, ProcessId } from "../core/types.js";

const signalNames = new Set(Object.keys(constants.signals));
const nodeAutoPropagatedEnvironmentKeys = [
	"NODE_V8_COVERAGE",
	"_BPXK_AUTOCVT",
	"_CEE_RUNOPTS",
	"_TAG_REDIR_ERR",
	"_TAG_REDIR_IN",
	"_TAG_REDIR_OUT",
	"STEPLIB",
	"LIBPATH",
	"_EDC_SIG_DFLT",
	"_EDC_SUSV3",
];

function createSpawnEnvironment(
	requested: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...(requested ?? {}) };
	for (const name of nodeAutoPropagatedEnvironmentKeys) {
		if (process.platform === "win32") {
			const existingName = Object.keys(env).find(
				(key) => key.toUpperCase() === name.toUpperCase(),
			);
			if (existingName && existingName !== name) {
				env[name] = env[existingName];
				delete env[existingName];
			}
		}
		if (!Object.hasOwn(env, name)) env[name] = undefined;
	}
	return env;
}

export class NodeProcessProvider implements ProcessProvider {
	readonly descriptor = {
		id: "node-process" as AdapterId,
		capabilities: ["process.launch", "process.signal"] as const,
	};

	launch(request: ProcessLaunchRequest): Promise<ManagedProcess> {
		const stdio = request.stdio ?? "ignore";
		if (stdio !== "ignore" && stdio !== "pipe") {
			return Promise.reject(new Error("Invalid process stdio mode"));
		}
		return new Promise((resolve, reject) => {
			const child = spawn(request.executable, [...request.args], {
				cwd: request.cwd,
				env: createSpawnEnvironment(request.env),
				shell: false,
				stdio,
			});

			let started = false;
			let exited = false;
			let resolveExit!: (result: {
				code: number | null;
				signal: NodeJS.Signals | null;
			}) => void;
			const exit = new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolvePromise) => {
				resolveExit = resolvePromise;
			});

			child.once("exit", (code, signal) => {
				exited = true;
				resolveExit({ code, signal });
			});
			child.once("error", (error) => {
				if (!started) {
					reject(new Error("Process failed to start", { cause: error }));
				}
			});
			child.once("spawn", () => {
				started = true;
				resolve({
					id: randomUUID() as ProcessId,
					stdin: stdio === "pipe" ? child.stdin : null,
					stdout: stdio === "pipe" ? child.stdout : null,
					stderr: stdio === "pipe" ? child.stderr : null,
					exit,
					async sendSignal(signal: string): Promise<void> {
						if (!signalNames.has(signal)) {
							throw new Error("Invalid process signal");
						}
						if (exited) throw new Error("Process has already exited");
						try {
							if (!child.kill(signal as NodeJS.Signals)) {
								throw new Error("Operating system did not deliver signal");
							}
						} catch (error) {
							throw new Error("Failed to deliver process signal", {
								cause: error,
							});
						}
					},
				});
			});
		});
	}
}
