import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(
	new URL("../scripts/check-version.mjs", import.meta.url),
);

async function runVersionCheck(
	manifestVersion: string | undefined,
	lockVersion = manifestVersion,
	rootVersion = lockVersion,
) {
	const root = await mkdtemp(path.join(os.tmpdir(), "harnessd-version-check-"));
	try {
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				...(manifestVersion ? { version: manifestVersion } : {}),
			}),
		);
		await writeFile(
			path.join(root, "package-lock.json"),
			JSON.stringify({
				version: lockVersion,
				packages: { "": { version: rootVersion } },
			}),
		);
		return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("package version check", () => {
	it.each([
		"0.1.0",
		"1.0.0",
		"2.4.0-rc.2",
		"1.2.3+build.01",
		"1.2.3-beta.2+sha.ab12",
	])("accepts valid SemVer %s", async (version) => {
		const result = await runVersionCheck(version);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`harnessd version ${version}`);
	});

	it.each(["01.2.3", "1.2", "1.2.3-rc.01", "v1.2.3", "1.2.3-", "1.2.3\n"])(
		"rejects invalid SemVer %s",
		async (version) => {
			const result = await runVersionCheck(version);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("valid SemVer");
		},
	);

	it("rejects a missing manifest version", async () => {
		const result = await runVersionCheck(undefined);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("valid SemVer");
	});

	it("rejects a mismatch in either package-lock version field", async () => {
		const topLevelMismatch = await runVersionCheck("1.2.3", "1.2.4", "1.2.3");
		const packageEntryMismatch = await runVersionCheck(
			"1.2.3",
			"1.2.3",
			"1.2.4",
		);
		for (const result of [topLevelMismatch, packageEntryMismatch]) {
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("versions must match");
		}
	});
});
