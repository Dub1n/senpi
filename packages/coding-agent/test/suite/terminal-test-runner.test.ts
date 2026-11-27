import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTestRunnerCommand } from "../../src/core/extensions/builtin/terminal/tools/test-runner-contract.ts";
import { prepareTestRun } from "../../src/core/extensions/builtin/terminal/tools/test-runner.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

function createProject(
	testSource: string,
	testOptions: { readonly hookTimeout?: number } = {},
): { directory: string; config: string; reporterMarker: string } {
	const directory = mkdtempSync(join(tmpdir(), "senpi-vitest-project-"));
	symlinkSync(resolve(packageRoot, "../../node_modules"), join(directory, "node_modules"), "dir");
	const testFile = join(directory, "contract.test.mjs");
	const reporterPath = join(directory, "retained-reporter.mjs");
	const reporterMarker = join(directory, "reporter-ran");
	const config = join(directory, "vitest.config.mjs");
	writeFileSync(testFile, testSource);
	writeFileSync(
		reporterPath,
		`import { writeFile } from "node:fs/promises"; export default class { async onTestRunEnd() { await writeFile(${JSON.stringify(reporterMarker)}, "ok"); } }`,
	);
	const hookTimeout = testOptions.hookTimeout === undefined ? "" : `hookTimeout: ${testOptions.hookTimeout}, `;
	writeFileSync(
		config,
		`export default { test: { ${hookTimeout}reporters: ["default", ${JSON.stringify(reporterPath)}] } };`,
	);
	return { directory, config, reporterMarker };
}

async function runVitest(
	directory: string,
	config: string,
	exitOverride?: {
		readonly exitCode: number | null;
		readonly signal: unknown;
		readonly cancelled: boolean;
		readonly timedOut: boolean;
	},
	launcher: "direct" | "bun-script" = "direct",
) {
	const prepared = prepareTestRun(
		"vitest",
		["--root", directory, "--config", config],
		packageRoot,
		launcher === "direct" ? undefined : { launcher, cwd: packageRoot },
	);
	const invocation = await prepared;
	const child = spawnSync(invocation.command, invocation.args, {
		cwd: packageRoot,
		encoding: "utf8",
		timeout: 30_000,
		...(launcher === "bun-script"
			? { env: { ...process.env, OMO_CODING_AGENT_DIR: join(directory, "must-not-inherit") } }
			: {}),
	});
	const exit = {
		exitCode: child.status,
		signal: child.signal,
		cancelled: false,
		timedOut: child.error !== undefined,
	};
	const summary = invocation.finish(exitOverride ?? exit);
	return { child, exit: exitOverride ?? exit, prepared: invocation, summary };
}

describe("local Vitest test-runner adapter", () => {
	it("recognizes only unambiguous direct and Bun test commands", () => {
		expect(classifyTestRunnerCommand("vitest run --root packages/coding-agent", packageRoot)).toEqual({
			runner: "vitest",
			args: ["--root", "packages/coding-agent"],
		});
		expect(classifyTestRunnerCommand("vitest --run --root packages/coding-agent", packageRoot)).toEqual({
			runner: "vitest",
			args: ["--root", "packages/coding-agent"],
		});
		expect(classifyTestRunnerCommand("vitest", packageRoot)).toBeUndefined();
		expect(
			classifyTestRunnerCommand("bun run --cwd packages/coding-agent test -- --watch=false", repositoryRoot),
		).toEqual({
			runner: "vitest",
			args: ["--watch=false"],
			launcher: "bun-script",
			cwd: resolve(packageRoot),
		});
		expect(classifyTestRunnerCommand("bun run test && echo done", packageRoot)).toBeUndefined();
		expect(classifyTestRunnerCommand("vitest --config '$HOME/vitest.config.ts'", packageRoot)).toBeUndefined();
		expect(classifyTestRunnerCommand("vitest test/**/*.test.ts", packageRoot)).toBeUndefined();
		expect(classifyTestRunnerCommand("vitest\nbun run test", packageRoot)).toBeUndefined();
	});

	it("runs through the verified Bun package script and keeps configured reporters", async () => {
		const project = createProject(
			`import { expect, it } from "vitest";
			it("quarantines inherited agent paths", () => {
				expect(process.env.OMO_CODING_AGENT_DIR).toBeUndefined();
				expect(process.env.SENPI_CODING_AGENT_DIR).toBe(process.env.TMPDIR + "/agent");
			});
			it("fails", () => expect(1).toBe(2));`,
		);
		try {
			const { child, prepared, summary } = await runVitest(
				project.directory,
				project.config,
				undefined,
				"bun-script",
			);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 1, failed: 1, skipped: 0 });
			expect(`${child.stdout}\n${child.stderr}`).toContain("Test Files");
			expect(existsSync(project.reporterMarker)).toBe(true);
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("rejects unsupported package scripts and pretest lifecycle hooks", async () => {
		await expect(
			prepareTestRun("vitest", [], packageRoot, {
				launcher: "bun-script",
				cwd: tmpdir(),
			}),
		).rejects.toThrow("The package test script must invoke this repository's run-tests.mjs with Vitest.");
		const lifecyclePackage = mkdtempSync(join(tmpdir(), "senpi-vitest-lifecycle-"));
		try {
			const launcherPath = relative(lifecyclePackage, resolve(repositoryRoot, "scripts/run-tests.mjs"));
			writeFileSync(
				join(lifecyclePackage, "package.json"),
				JSON.stringify({
					scripts: {
						test: `node ${launcherPath} vitest --run`,
						pretest: "echo setup",
					},
				}),
			);
			expect(classifyTestRunnerCommand(`bun run --cwd ${lifecyclePackage} test`, repositoryRoot)).toBeUndefined();
		} finally {
			rmSync(lifecyclePackage, { recursive: true, force: true });
		}
	});

	it("returns attributed passing counts and preserves the configured reporter", async () => {
		const project = createProject(`import { expect, it } from "vitest"; it("passes", () => expect(2 + 2).toBe(4));`);
		try {
			const { child, prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 1, failed: 0, skipped: 0 });
			expect(`${child.stdout}\n${child.stderr}`).toContain("Test Files");
			expect(`${child.stdout}\n${child.stderr}`).not.toContain("senpi-vitest-run");
			expect(existsSync(project.reporterMarker)).toBe(true);
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("returns mixed passing and failing case counts with Vitest's failed exit", async () => {
		const project = createProject(
			`import { expect, it } from "vitest"; it("passes", () => expect(3 + 4).toBe(7)); it("fails", () => expect(1).toBe(2));`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 1, failed: 1, skipped: 0 });
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("counts skipped cases without treating them as failures", async () => {
		const project = createProject(
			`import { expect, it } from "vitest"; it("passes", () => expect(3 + 4).toBe(7)); it.skip("skips", () => {});`, // test-junk-ok: skipped fixture verifies skipped-count reporting
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 1, failed: 0, skipped: 1 });
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("counts assertion failures after a successful beforeEach hook", async () => {
		const project = createProject(
			`import { beforeEach, expect, it } from "vitest"; beforeEach(() => {}); it("fails", () => expect(1).toBe(2));`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 0, failed: 1, skipped: 0 });
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("counts assertion failures after a successful beforeAll hook", async () => {
		const project = createProject(
			`import { beforeAll, expect, it } from "vitest"; beforeAll(() => {}); it("fails", () => expect(1).toBe(2));`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toEqual({ version: 1, runner: "vitest", passed: 0, failed: 1, skipped: 0 });
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when a failed teardown hook shares a failing assertion", async () => {
		const project = createProject(
			`import { afterEach, expect, it } from "vitest"; afterEach(() => { throw new Error("teardown failed"); }); it("fails", () => expect(1).toBe(2));`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when a per-case setup hook times out", async () => {
		const project = createProject(
			`import { beforeEach, describe, it } from "vitest"; describe("hook timeout", () => { beforeEach(() => new Promise(() => {})); it("never runs", () => {}); });`,
			{ hookTimeout: 20 },
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when a suite hook fails without an attributable failed case", async () => {
		const project = createProject(
			`import { beforeAll, describe, it } from "vitest"; describe("hook failure", () => { beforeAll(() => { throw new Error("setup failed"); }); it("never runs", () => {}); });`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when a per-case setup hook fails", async () => {
		const project = createProject(
			`import { beforeEach, describe, it } from "vitest"; describe("hook failure", () => { beforeEach(() => { throw new Error("setup failed"); }); it("never runs", () => {}); });`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when a per-case teardown hook fails", async () => {
		const project = createProject(
			`import { afterEach, describe, it } from "vitest"; describe("hook failure", () => { afterEach(() => { throw new Error("teardown failed"); }); it("passes", () => {}); });`,
		);
		try {
			const { prepared, summary } = await runVitest(project.directory, project.config);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when setup fails before any test modules finish", async () => {
		const project = createProject(`import { expect, it } from "vitest"; it("passes", () => expect(3 + 4).toBe(7));`);
		try {
			const { prepared, summary } = await runVitest(
				project.directory,
				join(project.directory, "missing.config.mjs"),
			);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts when exit status conflicts with the Vitest receipt", async () => {
		const project = createProject(`import { expect, it } from "vitest"; it("passes", () => expect(3 + 4).toBe(7));`);
		try {
			const exit = { exitCode: 1, signal: null, cancelled: false, timedOut: false };
			const { prepared, summary } = await runVitest(project.directory, project.config, exit);
			expect(summary).toBeUndefined();
			prepared.dispose();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});

	it("omits counts for cancelled runs and disposes its private invocation directory", async () => {
		const project = createProject(`import { expect, it } from "vitest"; it("passes", () => expect(3 + 4).toBe(7));`);
		try {
			const { prepared } = await runVitest(project.directory, project.config, {
				exitCode: 0,
				signal: null,
				cancelled: true,
				timedOut: false,
			});
			const invocationPath = prepared.args[1];
			expect(invocationPath).toBeDefined();
			const privateDirectory = invocationPath ? resolve(invocationPath, "..") : "";
			prepared.dispose();
			expect(existsSync(privateDirectory)).toBe(false);
			expect(prepared.finish({ exitCode: 0, signal: null, cancelled: false, timedOut: false })).toBeUndefined();
		} finally {
			rmSync(project.directory, { recursive: true, force: true });
		}
	});
});
