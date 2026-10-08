export async function writeClaudeMcpMessage(
	output: NodeJS.WritableStream,
	value: unknown,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throw new Error("MCP server stopped");
	const line = `${JSON.stringify(value)}\n`;
	if (output.write(line)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			output.removeListener("drain", drained);
			output.removeListener("error", failed);
			signal.removeEventListener("abort", aborted);
		};
		const drained = () => {
			cleanup();
			resolve();
		};
		const failed = (error: Error) => {
			cleanup();
			reject(error);
		};
		const aborted = () => {
			cleanup();
			reject(new Error("MCP server stopped"));
		};
		output.once("drain", drained);
		output.once("error", failed);
		signal.addEventListener("abort", aborted, { once: true });
	});
}
