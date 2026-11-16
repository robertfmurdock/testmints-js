import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { isDeepStrictEqual, promisify } from "node:util";
import { gunzip } from "node:zlib";
import tar from "tar-stream";

const exec = promisify(execFile);
const decompress = promisify(gunzip);
const registry = "https://registry.npmjs.org";
const stableVersion = /^\d+\.\d+\.\d+$/;
const tarBlockSize = 512;

async function packageContents(path) {
	const archive = await decompress(await readFile(path));
	const entries = tar.extract();
	entries.end(archive);

	// Archive order, compression, timestamps, ownership, directories and mode
	// bits other than executable bits do not enter the comparison.
	const contents = new Map();
	const seen = new Set();
	let endOfEntries = 0;
	for await (const entry of entries) {
		const { name, type, mode, size } = entry.header;
		endOfEntries =
			entry.offset + tarBlockSize * (1 + Math.ceil(size / tarBlockSize));
		const parts = name.replace(/\/$/, "").split("/");
		const archivePath = parts.join("/");
		if (
			parts[0] !== "package" ||
			parts.some((part) => part === "" || part === "." || part === "..")
		) {
			throw new Error(`Invalid package path: ${JSON.stringify(name)}`);
		}
		if (seen.has(archivePath)) {
			throw new Error(`Duplicate archive entry: ${JSON.stringify(name)}`);
		}
		seen.add(archivePath);
		if (type === "directory") continue;
		if (type !== "file" || parts.length < 2 || name.endsWith("/")) {
			throw new Error(`Unsupported archive entry: ${JSON.stringify(name)}`);
		}

		const relativePath = parts.slice(1).join("/");
		let contentsToCompare = await buffer(entry);
		if (relativePath === "package.json") {
			// Ignore the generated release version and development-only dependencies.
			const manifest = JSON.parse(contentsToCompare.toString("utf8"));
			if (typeof manifest?.version !== "string") {
				throw new Error("Package manifest is missing its version");
			}
			delete manifest.version;
			delete manifest.devDependencies;
			contentsToCompare = manifest;
		}
		contents.set(relativePath, {
			data: contentsToCompare,
			executableBits: mode & 0o111,
		});
	}
	const terminator = archive.subarray(endOfEntries);
	if (terminator.length < 2 * tarBlockSize || terminator.some(Boolean)) {
		throw new Error("Invalid tar archive terminator");
	}
	if (!contents.has("package.json")) {
		throw new Error("Archive is missing package.json");
	}
	return contents;
}

async function latestVersion(packageName) {
	const response = await fetch(
		`${registry}/${encodeURIComponent(packageName)}`,
		{
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (response.status === 404) return undefined;
	if (!response.ok) {
		throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
	}
	const metadata = await response.json();
	const version = metadata["dist-tags"]?.latest;
	if (
		!stableVersion.test(version) ||
		!Object.hasOwn(metadata.versions, version)
	) {
		throw new Error(`npm latest points to an unknown version: ${version}`);
	}
	return version;
}

async function publishedContents(packageName, version) {
	const directory = await mkdtemp(join(tmpdir(), "testmints-baseline-"));
	try {
		const { stdout } = await exec("npm", [
			"pack",
			`${packageName}@${version}`,
			"--json",
			"--ignore-scripts",
			"--prefer-online",
			`--registry=${registry}`,
			"--pack-destination",
			directory,
		]);
		const [baseline] = JSON.parse(stdout);
		return await packageContents(join(directory, baseline.filename));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function shouldPublish(packageName, candidate) {
	const current = await packageContents(candidate);
	const version = await latestVersion(packageName);
	if (version === undefined) {
		const { stdout } = await exec("git", ["tag", "--list"]);
		const stableTags = stdout
			.split(/\r?\n/)
			.filter((tag) => stableVersion.test(tag));
		if (!isDeepStrictEqual(stableTags, ["0.0.0"])) {
			throw new Error(`npm package ${packageName} is missing after bootstrap`);
		}
		console.error("npm package is absent and only the bootstrap tag exists.");
		return true;
	}

	console.error(`Comparing with ${packageName}@${version}`);
	const previous = await publishedContents(packageName, version);
	const paths = new Set([...current.keys(), ...previous.keys()]);
	const changed = [...paths]
		.sort()
		.filter(
			(path) => !isDeepStrictEqual(current.get(path), previous.get(path)),
		);
	for (const path of changed) {
		console.error(`Changed package path: ${JSON.stringify(path)}`);
	}
	if (changed.length === 0) {
		console.error("Package contents match. Skipping the release.");
	}
	return changed.length > 0;
}

const [packageName, candidate] = process.argv.slice(2);
if (process.argv.length !== 4) {
	throw new Error(
		"Usage: node scripts/compare-release.mjs <package> <tarball>",
	);
}
console.log(`publish=${await shouldPublish(packageName, candidate)}`);
