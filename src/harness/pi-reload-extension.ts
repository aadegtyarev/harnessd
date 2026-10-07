interface PiReloadContext {
	reload(): Promise<void>;
}

interface PiReloadExtensionApi {
	registerCommand(
		name: string,
		options: {
			description: string;
			handler(args: string, context: PiReloadContext): Promise<void>;
		},
	): void;
}

export default function registerPiReloadCommand(
	pi: PiReloadExtensionApi,
): void {
	pi.registerCommand("harnessd-reload", {
		description: "Internal harnessd command to reload Pi resources.",
		async handler(args, context) {
			if (args.trim()) throw new Error("Arguments are not supported");
			await context.reload();
			return;
		},
	});
}
