import { getTelegramCommands } from "./command-catalog.js";
import type { HarnessCommand } from "./core/ports.js";

export const TELEGRAM_COMMAND_LIMIT = 100;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function isNativeTelegramCommand(name: string): boolean {
	const normalized = name.toLowerCase();
	return getTelegramCommands().some(
		(command) => command.command.toLowerCase() === normalized,
	);
}

export function safeExtensionDescription(value: string): string {
	const safe = value
		.replace(/(?:^|\s)(?:\/|[A-Za-z]:\\)[^\s]*/g, " ")
		.replace(/\p{Cc}/gu, " ")
		.replace(/[<>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return [...safe].slice(0, 256).join("") || "Pi extension command.";
}

export function extensionCommands(
	commands: readonly HarnessCommand[],
): readonly HarnessCommand[] {
	const seen = new Set<string>();
	return commands
		.filter(({ name }) => /^[a-z][a-z0-9_-]{0,31}$/.test(name))
		.filter(({ name }) => {
			const normalized = name.toLowerCase();
			if (seen.has(normalized) || isNativeTelegramCommand(normalized))
				return false;
			seen.add(normalized);
			return true;
		})
		.map(({ name, description }) => ({
			name,
			description: safeExtensionDescription(description),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function telegramMenuCommands(
	extensions: readonly HarnessCommand[],
): readonly { readonly command: string; readonly description: string }[] {
	const native = getTelegramCommands();
	const remaining = Math.max(0, TELEGRAM_COMMAND_LIMIT - native.length);
	return [
		...native,
		...extensionCommands(extensions)
			.filter(({ name }) => /^[a-z0-9_]+$/.test(name))
			.slice(0, remaining)
			.map(({ name, description }) => ({
				command: name,
				description,
			})),
	];
}

export function paginateTelegramHelp(
	lines: readonly string[],
	limit = TELEGRAM_MESSAGE_LIMIT,
): readonly string[] {
	const pages: string[] = [];
	let page = "";
	for (const line of lines) {
		const addition = page ? `\n${line}` : line;
		if (addition.length > limit) continue;
		if (page && page.length + addition.length > limit) {
			pages.push(page);
			page = line;
		} else page += addition;
	}
	if (page) pages.push(page);
	return pages;
}
