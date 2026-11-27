import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestRunnerRequest {
	readonly runner: "vitest";
	readonly args: readonly string[];
	readonly launcher?: "direct" | "bun-script";
	readonly cwd?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../../");
const runTestsPath = resolve(repositoryRoot, "scripts/run-tests.mjs");
const simpleArg = /^[A-Za-z0-9_./:@%+=,-]+$/;

/**
 * Recognize only unquoted, whitespace-separated Vitest commands with no shell syntax.
 */
export function classifyTestRunnerCommand(command: string, cwd: string): TestRunnerRequest | undefined {
	if (/[\u0000-\u001f\u007f]/.test(command)) return undefined;
	const tokens = command.trim().split(/ +/);
	if (tokens.length === 0 || tokens.some((token) => !simpleArg.test(token))) return undefined;

	if (tokens[0] === "vitest") {
		if (tokens[1] !== "run" && tokens[1] !== "--run") return undefined;
		return { runner: "vitest", args: tokens.slice(2) };
	}

	if (tokens[0] !== "bun" || tokens[1] !== "run") return undefined;
	let index = 2;
	let packageCwd = cwd;
	if (tokens[index] === "--cwd") {
		const path = tokens[index + 1];
		if (!path) return undefined;
		packageCwd = isAbsolute(path) ? path : resolve(cwd, path);
		index += 2;
	}
	if (tokens[index] !== "test") return undefined;
	index += 1;
	if (tokens[index] === "--") index += 1;
	if (verifyBunTestScript(packageCwd) === undefined) return undefined;
	return {
		runner: "vitest",
		args: tokens.slice(index),
		launcher: "bun-script",
		cwd: packageCwd,
	};
}

/**
 * Return the argument prefix only when this package's test script invokes this repository's launcher.
 */
export function verifyBunTestScript(packageCwd: string): readonly string[] | undefined {
	try {
		const realPackageCwd = realpathSync(packageCwd);
		const manifest = JSON.parse(readFileSync(resolve(realPackageCwd, "package.json"), "utf8")) as {
			scripts?: { test?: unknown; pretest?: unknown; posttest?: unknown };
		};
		const scripts = manifest.scripts;
		if (
			!scripts ||
			Object.hasOwn(scripts, "pretest") ||
			Object.hasOwn(scripts, "posttest") ||
			typeof scripts.test !== "string"
		)
			return undefined;
		const tokens = scripts.test.trim().split(/\s+/);
		if (tokens.length < 3 || tokens.some((token) => !simpleArg.test(token))) return undefined;
		if (tokens[0] !== "node" || tokens[2] !== "vitest") return undefined;
		if (resolve(realPackageCwd, tokens[1]) !== runTestsPath) return undefined;
		return tokens.slice(3);
	} catch {
		return undefined;
	}
}

/** Read the private reporter handoff that run-tests.mjs receives from the adapter worker. */
export function readVitestReporterHandoff(
	env: NodeJS.ProcessEnv,
): { readonly receiptPath: string; readonly reporterPath: string; readonly runId: string } | undefined {
	const receiptPath = env.SENPI_TEST_RUN_RECEIPT;
	const reporterPath = env.SENPI_TEST_RUN_REPORTER;
	const runId = env.SENPI_TEST_RUN_ID;
	if (receiptPath === undefined || reporterPath === undefined || runId === undefined) return undefined;
	return { receiptPath, reporterPath, runId };
}
