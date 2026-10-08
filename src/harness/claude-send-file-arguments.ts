export interface ClaudeSendFileArguments {
	readonly path: string;
	readonly caption?: string;
}

export function validateClaudeSendFileArguments(
	params: unknown,
): ClaudeSendFileArguments | undefined {
	if (typeof params !== "object" || params === null || Array.isArray(params))
		return undefined;
	const call = params as Record<string, unknown>;
	if (
		call.name !== "send_file" ||
		typeof call.arguments !== "object" ||
		call.arguments === null ||
		Array.isArray(call.arguments)
	)
		return undefined;
	const args = call.arguments as Record<string, unknown>;
	if (
		Object.keys(args).some((key) => key !== "path" && key !== "caption") ||
		typeof args.path !== "string" ||
		args.path.length < 1 ||
		args.path.length > 4096 ||
		args.path.includes("\0") ||
		(args.caption !== undefined &&
			(typeof args.caption !== "string" || [...args.caption].length > 1024))
	)
		return undefined;
	return args.caption === undefined
		? { path: args.path }
		: { path: args.path, caption: args.caption as string };
}
