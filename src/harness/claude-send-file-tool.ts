export const CLAUDE_SEND_FILE_TOOL = {
	name: "send_file",
	description:
		"Send one workspace file to authorized chats selecting this session. Do not retry partial or uncertain delivery.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				minLength: 1,
				maxLength: 4096,
				description: "Path relative to this session workspace",
			},
			caption: { type: "string", maxLength: 1024 },
		},
		required: ["path"],
		additionalProperties: false,
	},
} as const;
