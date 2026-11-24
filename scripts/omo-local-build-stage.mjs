#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

const [output, scratch, desktop] = process.argv.slice(2);
assert(output && scratch && desktop, "Expected output directory, disposable build directory and desktop sidecar");
const omo = realpathSync(join(scratch, "omo"));
const engine = realpathSync(join(scratch, "engine"));
const pin = "2026.11.18-2";
const workspaceTargets = {
	"coding-agent": { name: "@code-yeongyu/senpi", root: "dist" },
	tui: { name: "@code-yeongyu/senpi-tui", root: "dist" },
	"senpi-codemode": { name: "@code-yeongyu/senpi-codemode", root: "src" },
};
const patch = readFileSync(join(output, "senpi.patch"));
const sources = readFileSync(join(output, "runtime-paths"), "utf8").split("\0").filter(Boolean);
assert(sources.length, "Missing runtime sources in patch");

function replaceFile(source, destination) {
	const temporary = `${destination}.dense-${process.pid}`;
	copyFileSync(source, temporary);
	renameSync(temporary, destination);
}

function readPackage(dir) {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function resolvePackage(req, specifier, expectedName) {
	const manifestPath = realpathSync(req.resolve(`${specifier}/package.json`));
	const dir = dirname(manifestPath);
	assert(dir.startsWith(join(omo, "node_modules") + sep), `Package resolves outside the OmO clone: ${manifestPath}`);
	const manifest = readPackage(dir);
	assert(
		manifest.name === expectedName && manifest.version === pin,
		`Expected ${expectedName}@${pin} at ${dir}, found ${manifest.name}@${manifest.version}`,
	);
	return { dir, manifest };
}

const engineRoots = new Set();
for (const dir of [omo, ...["omo-native", "omo-senpi", "senpi-task"].map((name) => join(omo, "packages", name))]) {
	const req = createRequire(join(dir, "package.json"));
	const specifier = workspaceTargets["coding-agent"].name;
	engineRoots.add(resolvePackage(req, specifier, specifier).dir);
}
assert.equal(engineRoots.size, 1, "OmO workspaces resolve more than one Senpi copy");
const [enginePackage] = engineRoots;
assert.equal(enginePackage, realpathSync(join(omo, "node_modules", "@code-yeongyu", "senpi")));

// Match the packager: Bun's isolated install resolves sidecars from Senpi's real package location.
const requireFromEngine = createRequire(join(enginePackage, "package.json"));
const tuiPackage = resolvePackage(requireFromEngine, "@earendil-works/pi-tui", workspaceTargets.tui.name).dir;
const codemodeName = workspaceTargets["senpi-codemode"].name;
const codemode = resolvePackage(requireFromEngine, codemodeName, codemodeName);
assert.equal(codemode.manifest.main, "./src/index.ts", "Expected source-only codemode entry");
assert.equal(
	realpathSync(requireFromEngine.resolve(codemodeName)),
	join(codemode.dir, "src", "index.ts"),
	"Codemode entry must resolve to its own src/index.ts",
);
const packageRoots = { "coding-agent": enginePackage, tui: tuiPackage, "senpi-codemode": codemode.dir };
for (const [workspace, target] of Object.entries(workspaceTargets)) {
	const manifest = readPackage(join(engine, "packages", workspace));
	// The TUI checkout uses the private workspace name; the npm tarball uses the published name.
	const name = workspace === "tui" ? "@earendil-works/pi-tui" : target.name;
	assert(manifest.name === name && manifest.version === pin, `Unexpected pinned engine workspace: ${workspace}`);
}

for (const file of sources) {
	const match = /^packages\/(coding-agent|tui|senpi-codemode)\/src\/(.+)\.ts$/.exec(file);
	assert(match, `Unsupported runtime source: ${file}`);
	const [, workspace, stem] = match;
	const parts = stem.split("/");
	assert(
		parts.every((part) => part && part !== "." && part !== ".."),
		`Noncanonical runtime source: ${file}`,
	);
	const { root } = workspaceTargets[workspace];
	const suffix = root === "src" ? ".ts" : ".js";
	const installed = packageRoots[workspace];
	const staged = `${parts.pop()}${suffix}`;
	let parent = installed;
	for (const part of [root, ...parts]) {
		parent = join(parent, part);
		const metadata = lstatSync(parent, { throwIfNoEntry: false });
		if (metadata === undefined) mkdirSync(parent);
		else assert(metadata.isDirectory(), `Overlay parent is not a real directory: ${parent}`);
	}
	replaceFile(join(engine, "packages", workspace, root, `${stem}${suffix}`), join(parent, staged));
	console.log(`Staged ${workspace}/${root}/${stem}${suffix}`);
}

const desktopDestination = join(omo, "target", "x86_64-unknown-linux-gnu", "release", "senpi-desktop-engine");
mkdirSync(dirname(desktopDestination), { recursive: true });
replaceFile(desktop, desktopDestination);

function sourceInfo(dir, branch) {
	const [commit, committedAt] = execFileSync("git", ["-C", dir, "log", "-1", "--format=%H%n%cI"], {
		env: { ...process.env, GIT_MASTER: "1" },
		encoding: "utf8",
	})
		.trim()
		.split("\n");
	return { commit, committedAt, branch };
}

const digest = createHash("sha256").update(patch).digest("hex");
const nicknamePins = join(output, "nickname-pins");
const [nicknameRevision, senpiRevision] = existsSync(nicknamePins)
	? readFileSync(nicknamePins, "utf8").trim().split("\n")
	: [];
const nicknameBuild = nicknameRevision ? `; OmO nickname overlay ${nicknameRevision}; Senpi checkout ${senpiRevision}` : "";
const provenance = {
	command: `local dense-card OmO build (Senpi patch sha256:${digest}${nicknameBuild})`,
	omo: sourceInfo(omo, "v5.1.78"),
	engine: sourceInfo(engine, `v${pin}+dense.${digest.slice(0, 10)}`),
};
// The per-run suffix prevents a candidate from reusing an existing candidate's runtime.
const runId = createHash("sha256").update(output).digest("hex").slice(0, 10);
const runtime = `0.0.0-omob.dense.${provenance.omo.commit.slice(0, 7)}.${digest.slice(0, 10)}.${runId}`;
writeFileSync(join(output, "patch.sha256"), `${digest}  senpi.patch\n`);
writeFileSync(join(output, "build-info.json"), `${JSON.stringify(provenance)}\n`);
writeFileSync(join(output, "runtime-id"), `${runtime}\n`);
console.log(`Prepared ${runtime}`);
