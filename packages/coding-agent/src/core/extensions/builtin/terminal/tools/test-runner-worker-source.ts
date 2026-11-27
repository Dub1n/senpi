// Reporter module shared by the direct adapter worker and scripts/run-tests.mjs.
export const vitestReporterSource = `
import { rename, writeFile } from "node:fs/promises";

export function createSenpiReporter({ runId, receiptPath }) {
	let runEnds = 0;
	let hookAmbiguities = 0;
	const pendingHookCounts = new Map();
	return {
		async onTestRunEnd(modules, unhandledErrors, reason) {
			runEnds += 1;
			const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
			let suiteErrors = 0;
			let moduleErrors = 0;
			let failedSuitesWithoutFailedCase = 0;
			const countSuite = (suite, parentHooked) => {
				const hooked = parentHooked || pendingHookCounts.has(suite.id);
				const before = counts.failed;
				for (const child of suite.children.array()) {
					if (child.type === "test") {
						const state = child.result().state;
						if (state === "passed") counts.passed += 1;
						else if (state === "failed") {
							counts.failed += 1;
							if (hooked || pendingHookCounts.has(child.id)) hookAmbiguities += 1;
						} else if (state === "skipped") counts.skipped += 1;
						else counts.pending += 1;
					} else {
						countSuite(child, hooked);
					}
				}
				if (suite.type === "suite" && suite.errors().length > 0) suiteErrors += suite.errors().length;
				if (suite.type === "suite" && suite.state() === "failed" && counts.failed === before)
					failedSuitesWithoutFailedCase += 1;
			};
			for (const module of modules) {
				moduleErrors += module.errors().length;
				countSuite(module, false);
			}
			const cases = counts.passed + counts.failed + counts.skipped + counts.pending;
			const receipt = {
				kind: "senpi-vitest-run",
				version: 1,
				runId,
				complete: true,
				runEnds,
				reason,
				modules: modules.length,
				cases,
				...counts,
				unhandledErrors: unhandledErrors.length,
				suiteErrors,
				moduleErrors,
				hookAmbiguities,
				failedSuitesWithoutFailedCase,
			};
			const temporaryPath = receiptPath + "." + runEnds + ".tmp";
			await writeFile(temporaryPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
			await rename(temporaryPath, receiptPath);
		},
		onHookStart(hook) {
			const count = pendingHookCounts.get(hook.entity.id) ?? 0;
			pendingHookCounts.set(hook.entity.id, count + 1);
		},
		onHookEnd(hook) {
			const count = pendingHookCounts.get(hook.entity.id) ?? 0;
			if (count <= 1) pendingHookCounts.delete(hook.entity.id);
			else pendingHookCounts.set(hook.entity.id, count - 1);
		},
	};
}
`;

// Embedded Node bootstrap for either a direct or repository-script Vitest invocation.
export const vitestWorkerSource = `
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const invocation = JSON.parse(await readFile(process.argv[2], "utf8"));
if (invocation.launcher === "bun-script") {
	const child = spawn("bun", ["run", "--cwd", invocation.packageCwd, "test", "--", ...invocation.args], {
		cwd: invocation.cwd,
		env: {
			...process.env,
			SENPI_TEST_RUN_ID: invocation.runId,
			SENPI_TEST_RUN_RECEIPT: invocation.receiptPath,
			SENPI_TEST_RUN_REPORTER: invocation.reporterPath,
		},
		stdio: "inherit",
	});
	process.exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
} else {
	process.chdir(invocation.cwd);
	const require = createRequire(resolve(invocation.cwd, "package.json"));
	const vitestPath = require.resolve("vitest/node");
	const { createVitest, parseCLI, TestsNotFoundError } = await import(pathToFileURL(vitestPath).href);
	const parsed = parseCLI(["vitest", "run", ...invocation.args]);
	const options = parsed.options;
	if (options.watch || options.ui || options.open || options.mergeReports || options.reporter || options.outputFile) {
		throw new Error("The Vitest adapter accepts one non-watch run without custom reporters or output files.");
	}
	options.run = true;
	options.watch = false;
	const { createSenpiReporter } = await import(pathToFileURL(invocation.reporterPath).href);
	const vitest = await createVitest(options);
	vitest.reporters.push(createSenpiReporter({ runId: invocation.runId, receiptPath: invocation.receiptPath }));
	try {
		try {
			await vitest.start(parsed.filter);
		} catch (error) {
			if (!(error instanceof TestsNotFoundError)) throw error;
		}
	} finally {
		await vitest.close();
	}
}
`;
