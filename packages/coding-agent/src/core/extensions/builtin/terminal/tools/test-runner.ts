import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestSummary } from "./test-summary.ts";
import { verifyBunTestScript } from "./test-runner-contract.ts";
import { vitestReporterSource, vitestWorkerSource } from "./test-runner-worker-source.ts";

const MAX_RECEIPT_BYTES = 4096;
interface RunReceipt {
	readonly kind: "senpi-vitest-run";
	readonly version: 1;
	readonly runId: string;
	readonly complete: true;
	readonly runEnds: number;
	readonly reason: "passed" | "failed" | "interrupted";
	readonly modules: number;
	readonly cases: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly pending: number;
	readonly unhandledErrors: number;
	readonly suiteErrors: number;
	readonly moduleErrors: number;
	readonly hookAmbiguities: number;
	readonly failedSuitesWithoutFailedCase: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseReceipt(value: unknown, runId: string): RunReceipt | undefined {
	if (!isRecord(value)) return undefined;
	const keys = [
		"kind",
		"version",
		"runId",
		"complete",
		"runEnds",
		"reason",
		"modules",
		"cases",
		"passed",
		"failed",
		"skipped",
		"pending",
		"unhandledErrors",
		"suiteErrors",
		"moduleErrors",
		"hookAmbiguities",
		"failedSuitesWithoutFailedCase",
	];
	if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) return undefined;
	if (
		value.kind !== "senpi-vitest-run" ||
		value.version !== 1 ||
		value.runId !== runId ||
		value.complete !== true ||
		(value.reason !== "passed" && value.reason !== "failed" && value.reason !== "interrupted")
	)
		return undefined;
	if (
		!isCount(value.runEnds) ||
		!isCount(value.modules) ||
		!isCount(value.cases) ||
		!isCount(value.passed) ||
		!isCount(value.failed) ||
		!isCount(value.skipped) ||
		!isCount(value.pending) ||
		!isCount(value.unhandledErrors) ||
		!isCount(value.suiteErrors) ||
		!isCount(value.moduleErrors) ||
		!isCount(value.hookAmbiguities) ||
		!isCount(value.failedSuitesWithoutFailedCase)
	)
		return undefined;
	return {
		kind: "senpi-vitest-run",
		version: 1,
		runId,
		complete: true,
		runEnds: value.runEnds,
		reason: value.reason,
		modules: value.modules,
		cases: value.cases,
		passed: value.passed,
		failed: value.failed,
		skipped: value.skipped,
		pending: value.pending,
		unhandledErrors: value.unhandledErrors,
		suiteErrors: value.suiteErrors,
		moduleErrors: value.moduleErrors,
		hookAmbiguities: value.hookAmbiguities,
		failedSuitesWithoutFailedCase: value.failedSuitesWithoutFailedCase,
	};
}

function readReceipt(path: string, runId: string): RunReceipt | undefined {
	let descriptor: number | undefined;
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECEIPT_BYTES) return undefined;
		descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_RECEIPT_BYTES)
			return undefined;
		const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		const after = fstatSync(descriptor);
		const current = lstatSync(path);
		if (
			bytesRead > MAX_RECEIPT_BYTES ||
			after.size > MAX_RECEIPT_BYTES ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			current.isSymbolicLink() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino
		)
			return undefined;
		const serialized = buffer.subarray(0, bytesRead).toString("utf8");
		const value: unknown = JSON.parse(serialized);
		const receipt = parseReceipt(value, runId);
		if (
			!receipt ||
			JSON.stringify(receipt) !== serialized ||
			receipt.cases !== receipt.passed + receipt.failed + receipt.skipped + receipt.pending
		)
			return undefined;
		return receipt;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * Prepare one local Vitest CLI run and accept only its complete case receipt.
 */
export async function prepareTestRun(
	runner: string,
	args: readonly string[],
	cwd: string,
	options: { readonly launcher?: "direct" | "bun-script"; readonly cwd?: string } = {},
): Promise<{
	readonly command: string;
	readonly args: readonly string[];
	finish(
		exit: {
			readonly exitCode: number | null;
			readonly signal: unknown;
			readonly cancelled: boolean;
			readonly timedOut: boolean;
		} | null,
	): TestSummary | undefined;
	dispose(): void;
}> {
	if (runner !== "vitest") throw new Error(`Unsupported test runner: ${runner}`);
	const launcher = options.launcher ?? "direct";
	const packageCwd = launcher === "bun-script" ? options.cwd : undefined;
	if (launcher === "bun-script" && packageCwd === undefined)
		throw new Error("The bun-script Vitest launcher requires a package cwd.");
	const scriptPrefix = packageCwd === undefined ? [] : verifyBunTestScript(packageCwd);
	if (packageCwd !== undefined && scriptPrefix === undefined)
		throw new Error("The package test script must invoke this repository's run-tests.mjs with Vitest.");
	const effectiveArgs = [...(scriptPrefix ?? []), ...args];
	if (
		effectiveArgs.some(
			(arg) => /^--(?:watch|watchAll|ui|open|reporter|outputFile|merge-reports)(?:=|$)/.test(arg) || arg === "-r",
		)
	)
		throw new Error("The Vitest adapter does not accept watch mode, custom reporters, or external report paths.");

	const directory = mkdtempSync(join(tmpdir(), "senpi-vitest-"));
	const runId = randomUUID();
	const receiptPath = join(directory, "receipt.json");
	const invocationPath = join(directory, "invocation.json");
	const workerPath = join(directory, "worker.mjs");
	const reporterPath = join(directory, "reporter.mjs");
	try {
		writeFileSync(workerPath, vitestWorkerSource, { mode: 0o600 });
		writeFileSync(reporterPath, vitestReporterSource, { mode: 0o600 });
		writeFileSync(
			invocationPath,
			JSON.stringify({
				args,
				cwd,
				launcher,
				packageCwd,
				receiptPath,
				reporterPath,
				runId,
			}),
			{ mode: 0o600 },
		);
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}

	let finished = false;
	let disposed = false;
	return {
		command: "node",
		args: [workerPath, invocationPath],
		finish(exit) {
			if (finished || disposed) return undefined;
			finished = true;
			try {
				if (
					exit === null ||
					exit.cancelled ||
					exit.timedOut ||
					exit.signal !== null ||
					(exit.exitCode !== 0 && exit.exitCode !== 1)
				)
					return undefined;
				const receipt = readReceipt(receiptPath, runId);
				if (
					!receipt ||
					receipt.runEnds !== 1 ||
					receipt.reason === "interrupted" ||
					receipt.modules === 0 ||
					receipt.cases === 0 ||
					receipt.pending !== 0 ||
					receipt.unhandledErrors !== 0 ||
					receipt.suiteErrors !== 0 ||
					receipt.moduleErrors !== 0 ||
					receipt.hookAmbiguities !== 0 ||
					receipt.failedSuitesWithoutFailedCase !== 0 ||
					(receipt.reason === "passed" && (receipt.failed !== 0 || exit.exitCode !== 0)) ||
					(receipt.reason === "failed" && (receipt.failed === 0 || exit.exitCode !== 1))
				)
					return undefined;
				return {
					version: 1,
					runner: "vitest",
					passed: receipt.passed,
					failed: receipt.failed,
					skipped: receipt.skipped,
				};
			} catch {
				return undefined;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				return;
			}
		},
	};
}
