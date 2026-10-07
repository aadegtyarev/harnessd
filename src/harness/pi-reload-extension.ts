interface PiReloadContext {
	reload(): Promise<void>;
}

const COMMAND_ENV = "HARNESSD_PI_RELOAD_COMMAND";
const COMMAND_DESCRIPTION = "harnessd internal reload command";

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
	const command = process.env[COMMAND_ENV];
	if (!command || !/^harnessd-reload-[a-f0-9-]{36}$/.test(command)) return;
	pi.registerCommand(command, {
		description: COMMAND_DESCRIPTION,
		async handler(args, context) {
			if (args.trim()) throw new Error("Arguments are not supported");
			await context.reload();
			return;
		},
	});
}
