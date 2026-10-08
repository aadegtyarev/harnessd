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
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/start",
		telegram: { command: "start", description: "Начало работы с ботом." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/help",
		telegram: { command: "help", description: "Показать справку." },
	},

	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/menu",
		telegram: {
			command: "menu",
			description: "Открыть панель сессий.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/rename [sessionId] <name|--clear>",
		telegram: {
			command: "rename",
			description: "Задать или изменить имя сессии.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/sessions",
		telegram: { command: "sessions", description: "Показать список сессий." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/new [cwd]",
		telegram: {
			command: "new",
			description: "Создать сессию, при необходимости в папке.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/ls [path]",
		telegram: { command: "ls", description: "Показать файлы и папки." },
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/cd [path]",
		telegram: { command: "cd", description: "Перейти в папку." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/send <path>",
		telegram: {
			command: "send",
			description: "Отправить файл из рабочей папки сессии.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/use [sessionId]",
		telegram: {
			command: "use",
			description: "Выбрать сессию или подтвердить сохранённый выбор.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/resume [sessionId]",
		telegram: {
			command: "resume",
			description: "Возобновить остановленную сессию.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/inspect [sessionId]",
		telegram: {
			command: "inspect",
			description: "Показать сведения о сессии.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/status",
		telegram: {
			command: "status",
			description: "Показать статус выбранной сессии.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/reload",
		telegram: {
			command: "reload",
			description: "Перезагрузить ресурсы Pi без перезапуска сессии.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/model [provider/modelId [effort]]",
		telegram: { command: "model", description: "Показать или выбрать модель." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/effort [level|default]",
		telegram: {
			command: "effort",
			description: "Показать или задать effort модели.",
		},
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/permissions [mode|default]",
		telegram: {
			command: "permissions",
			description: "Показать или задать режим разрешений Claude.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/stop [sessionId]",
		telegram: { command: "stop", description: "Остановить сессию." },
	},
	{
		visibility: "telegram-only",
		section: "private-chat",
		usage: "/delete <sessionId>",
		telegram: {
			command: "delete",
			description: "Удалить запись остановленной сессии.",
		},
	},
	{
		visibility: "both",
		section: "private-chat",
		usage: "/cancel [inputId]",
		telegram: {
			command: "cancel",
			description: "Отменить активный ввод выбранной сессии.",
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

export function getTelegramCommands(includeCancel = true): readonly {
	readonly command: string;
	readonly description: string;
}[] {
	return COMMAND_CATALOG.flatMap((command) => {
		if (
			command.visibility === "cli-only" ||
			(!includeCancel && command.telegram.command === "cancel")
		)
			return [];
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

export function getTelegramHelpLines(includeCancel = true): readonly string[] {
	return COMMAND_CATALOG.flatMap((command) =>
		command.visibility === "cli-only" ||
		(!includeCancel && command.telegram.command === "cancel")
			? []
			: [`${command.usage} — ${command.telegram.description}`],
	);
}
