export type CommandVisibility = "cli-only" | "telegram-only" | "both";
export type CommandSection = "service" | "private-chat";

type CliOnlyCommand = {
	readonly visibility: "cli-only";
	readonly section: CommandSection;
	readonly usage: string;
	readonly cliDescription?: string;
};

type TelegramOnlyCommand = {
	readonly visibility: "telegram-only";
	readonly section: CommandSection;
	readonly usage: string;
	readonly telegram: {
		readonly command: string;
		readonly description: string;
	};
};

type SharedCommand = {
	readonly visibility: "both";
	readonly section: CommandSection;
	readonly usage: string;
	readonly cliDescription?: string;
	readonly telegram: {
		readonly command: string;
		readonly description: string;
	};
};

export type CommandDefinition =
	| CliOnlyCommand
	| TelegramOnlyCommand
	| SharedCommand;

export const COMMAND_CATALOG: readonly CommandDefinition[] = [
	{
		visibility: "cli-only",
		section: "service",
		usage: "harnessd service install",
		cliDescription: "Install, enable, and start the user service.",
	},
	{
		visibility: "cli-only",
		section: "service",
		usage: "harnessd service uninstall",
		cliDescription: "Stop, disable, and remove the user service.",
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/help",
		telegram: { command: "help", description: "Show available commands." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/menu",
		telegram: {
			command: "menu",
			description: "Open the session control panel.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/rename [sessionId] <name|--clear>",
		telegram: { command: "rename", description: "Name or rename a session." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/sessions",
		telegram: { command: "sessions", description: "List saved sessions." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/new [cwd]",
		telegram: {
			command: "new",
			description: "Create a session, optionally in a folder.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/ls [path]",
		telegram: { command: "ls", description: "List files and folders." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/cd [path]",
		telegram: { command: "cd", description: "Change the working folder." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/send <path>",
		telegram: { command: "send", description: "Send a session file." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/use [sessionId]",
		telegram: {
			command: "use",
			description: "Select a session or reuse this chat's remembered one.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/resume [sessionId]",
		telegram: { command: "resume", description: "Resume a stopped session." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/inspect [sessionId]",
		telegram: { command: "inspect", description: "Show a session's details." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/status",
		telegram: {
			command: "status",
			description: "Show the selected session's status.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/model [provider/modelId [effort]]",
		telegram: { command: "model", description: "List or select a model." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/effort [level]",
		telegram: { command: "effort", description: "List or set model effort." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/stop [sessionId]",
		telegram: { command: "stop", description: "Stop a session." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/delete <sessionId>",
		telegram: {
			command: "delete",
			description: "Delete a stopped session record.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/cancel <inputId>",
		telegram: {
			command: "cancel",
			description: "Cancel an input in the selected session.",
		},
	},
];

export function getCliCommandUsages(
	section: CommandSection,
): readonly { readonly usage: string; readonly description?: string }[] {
	return COMMAND_CATALOG.flatMap((command) => {
		if (command.visibility === "telegram-only" || command.section !== section)
			return [];
		return [
			{
				usage: command.usage,
				...(command.cliDescription
					? { description: command.cliDescription }
					: {}),
			},
		];
	});
}

export function getTelegramCommands(): readonly {
	readonly command: string;
	readonly description: string;
}[] {
	return COMMAND_CATALOG.flatMap((command) => {
		if (command.visibility === "cli-only") return [];
		return [
			{
				command: command.telegram.command,
				description: command.telegram.description,
			},
		];
	});
}

export function getTelegramHelpUsages(): readonly string[] {
	return COMMAND_CATALOG.flatMap((command) =>
		command.visibility === "cli-only" ? [] : [command.usage],
	);
}
