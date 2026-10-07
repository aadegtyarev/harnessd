const MANAGEMENT_TOOL =
	/^(?:subagent(?:_|$)|agent_(?:list|wait|steer|resume|status|control)$)/i;
const APPROVED_ROLES = new Map([
	["scout", "Scout"],
	["worker", "Worker"],
	["reviewer", "Reviewer"],
	["researcher", "Researcher"],
]);

export function approvedSubagentRole(summary: string): string | undefined {
	const match = /^subagent\s*·\s*([^·\s]+)(?:\s*·|$)/i.exec(summary.trim());
	return match ? APPROVED_ROLES.get(match[1].toLowerCase()) : undefined;
}

export function meaningfulToolSummary(summary: string): boolean {
	const normalized = summary.trim();
	if (!normalized) return false;
	if (approvedSubagentRole(normalized)) return true;
	if (/^subagent\s*·\s*workflow(?:\s*·|$)/i.test(normalized)) return false;
	const toolName = normalized.split(/[\s:·]/, 1)[0] ?? "";
	return !MANAGEMENT_TOOL.test(toolName);
}
