import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const version = process.env.RELEASE_VERSION;

if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
	throw new Error("RELEASE_VERSION must be a stable semantic version.");
}

const root = process.cwd();
const releaseDirectory = resolve(root, ".release");
const stagingDirectory = await mkdtemp(resolve(tmpdir(), "testmints-release-"));

try {
	await rm(releaseDirectory, { recursive: true, force: true });
	await mkdir(releaseDirectory, { recursive: true });
	const manifest = JSON.parse(
		await readFile(resolve(root, "package.json"), "utf8"),
	);
	manifest.version = version;

	await Promise.all([
		cp(resolve(root, "dist"), resolve(stagingDirectory, "dist"), {
			recursive: true,
		}),
		cp(resolve(root, "README.md"), resolve(stagingDirectory, "README.md")),
		cp(resolve(root, "LICENSE"), resolve(stagingDirectory, "LICENSE")),
		writeFile(
			resolve(stagingDirectory, "package.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		),
	]);

	const { stdout } = await exec(
		"npm",
		[
			"pack",
			"--json",
			"--ignore-scripts",
			"--pack-destination",
			releaseDirectory,
		],
		{ cwd: stagingDirectory },
	);
	const packed = Object.values(JSON.parse(stdout))[0];
	const filename =
		packed !== undefined && typeof packed === "object" && "filename" in packed
			? packed.filename
			: undefined;
	if (typeof filename !== "string")
		throw new Error("npm pack did not report a tarball.");
	console.log(resolve(releaseDirectory, filename));
} finally {
	await rm(stagingDirectory, { recursive: true, force: true });
}
