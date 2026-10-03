import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

/** Load an optional .env file without overriding the launching process environment. */
export async function loadDotEnv(
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<Readonly<NodeJS.ProcessEnv>> {
	const filePath = path.join(cwd, ".env");
	let contents: string;
	try {
		contents = await readFile(filePath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw new Error("HARNESSD_ENV_FILE_READ_FAILED");
	}

	let values: NodeJS.ProcessEnv;
	try {
		values = parseEnv(contents);
	} catch {
		throw new Error("HARNESSD_ENV_FILE_PARSE_FAILED");
	}
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && env[key] === undefined) env[key] = value;
	}
	return values;
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
