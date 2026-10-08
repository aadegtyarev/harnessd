import type { ToolPermissionDecision } from "../core/ports.js";

export function waitForPermissionDecision(
	decision: Promise<ToolPermissionDecision>,
	setTimer: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<ToolPermissionDecision> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<ToolPermissionDecision>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					behavior: "deny",
					message: "Permission prompt expired",
					interrupt: false,
				}),
			60_000,
		);
		setTimer(timer);
	});
	return Promise.race([decision, expired]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
