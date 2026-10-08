import { PassThrough } from "node:stream";
import type {
	ManagedProcess,
	ProcessLaunchRequest,
	ProcessProvider,
} from "../src/core/ports.js";
import type { AdapterId, ProcessId, SessionId } from "../src/core/types.js";

export function fakeProvider(
	options: {
		readonly ignoreTerm?: boolean;
		readonly rejectTerm?: boolean;
		readonly rejectKill?: boolean;
	} = {},
) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const signals: string[] = [];
	let exit!: (value: { code: number | null; signal: string | null }) => void;
	let ended = false;
	const written: string[] = [];
	const finish = () => {
		if (ended) return;
		ended = true;
		stdout.end();
		stderr.end();
		exit({ code: 0, signal: null });
	};
	stdin.setEncoding("utf8");
	stdin.on("data", (text: string) => written.push(text));
	const process = {
		id: "fake" as ProcessId,
		stdin,
		stdout,
		stderr,
		exit: new Promise<{ code: number | null; signal: string | null }>(
			(resolve) => {
				exit = resolve;
			},
		),
		async sendSignal(signal: string) {
			signals.push(signal);
			if (
				(signal === "SIGTERM" && options.rejectTerm) ||
				(signal === "SIGKILL" && options.rejectKill)
			)
				throw new Error("signal rejected");
			if (signal === "SIGKILL" || (signal === "SIGTERM" && !options.ignoreTerm))
				finish();
		},
	} as ManagedProcess;
	let request: ProcessLaunchRequest | undefined;
	const provider = {
		descriptor: { id: "fake" as AdapterId, capabilities: ["process.launch"] },
		async launch(value: ProcessLaunchRequest) {
			request = value;
			return process;
		},
	} as ProcessProvider;
	return {
		provider,
		process,
		args: () => request?.args,
		stdin,
		stdout,
		signals,
		inputLines: () => written,
		env: () => request?.env,
		record: (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`),
		finish,
	};
}

export const launchRequest = {
	sessionId: "11111111-1111-4111-8111-111111111111" as SessionId,
	cwd: "/tmp",
};
