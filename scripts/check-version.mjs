import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const numericIdentifier = "(?:0|[1-9]\\d*)";
const nonNumericIdentifier = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
const semverPattern = new RegExp(
	`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?![\\s\\S])`,
);

export function isSemVer(version) {
	return typeof version === "string" && semverPattern.test(version);
}

export function validateVersionRecords(manifest, lockfile) {
	const versions = [
		manifest?.version,
		lockfile?.version,
		lockfile?.packages?.[""]?.version,
	];
	if (versions.some((version) => !isSemVer(version)))
		throw new Error(
			"package.json and package-lock.json must contain valid SemVer versions",
		);
	if (versions.some((version) => version !== versions[0]))
		throw new Error("package.json and package-lock.json versions must match");
	return versions[0];
}

export async function checkVersion(
	root = fileURLToPath(new URL("..", import.meta.url)),
) {
	const [manifestText, lockfileText] = await Promise.all([
		readFile(path.join(root, "package.json"), "utf8"),
		readFile(path.join(root, "package-lock.json"), "utf8"),
	]);
	const version = validateVersionRecords(
		JSON.parse(manifestText),
		JSON.parse(lockfileText),
	);
	return version;
}

const invokedPath = process.argv[1]
	? pathToFileURL(path.resolve(process.argv[1])).href
	: undefined;
if (invokedPath === import.meta.url) {
	try {
		const version = await checkVersion(process.argv[2] ?? undefined);
		process.stdout.write(
			`harnessd version ${version}: package and lockfile agree\n`,
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Version validation failed";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
