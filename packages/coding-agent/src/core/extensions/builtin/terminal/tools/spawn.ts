import { getShellConfig } from "../../../../../utils/shell.ts";
import { attestSessionSpawn } from "../../../../session-spawn-attestation.ts";
import type { CreatedTerminalSession } from "../manager.ts";
import type { TerminalExitView, TerminalToolContext } from "./context.ts";
import type { TestSummary } from "./test-summary.ts";

export interface PreparedTestRun {
	readonly command: string;
	readonly args: readonly string[];
	finish(exit: TerminalExitView["exitResult"]): TestSummary | undefined;
	dispose(): void;
}

export interface SpawnRequest {
	readonly command: string;
	readonly testRun?: PreparedTestRun;
	readonly cols: number;
	readonly rows: number;
	/** Kill deadline in ms for foreground runs; omit for background sessions. */
	readonly timeoutMs?: number;
	/** Working directory override (execute-time `ctx.cwd`); falls back to the tool context cwd. */
	readonly cwd?: string;
	/** Environment overrides merged over `ctx.getEnv()` (foreground non-interactive env). */
	readonly envOverrides?: Readonly<Record<string, string>>;
	/** The session the command runs for; its pid is attested to that session (senpi#6972). */
	readonly sessionId?: string;
}

/**
 * Resolve the configured shell (honoring `SENPI_GIT_BASH_PATH` + shell kind) and spawn a
 * terminal session that runs `command` through it. For stdin-transport shells (legacy WSL
 * bash `-s`) the command is written to the PTY after start; otherwise it rides in argv.
 */
export async function spawnCommandSession(
	ctx: TerminalToolContext,
	request: SpawnRequest,
): Promise<CreatedTerminalSession> {
	const shell = request.testRun === undefined ? getShellConfig(ctx.shellPath) : undefined;
	const useStdin = shell?.commandTransport === "stdin";
	const executable =
		request.testRun ??
		(shell && { command: shell.shell, args: useStdin ? shell.args : [...shell.args, request.command] });
	if (executable === undefined) throw new Error("Terminal executable could not be resolved.");

	const launch = ctx.launchBarrier?.wrap(executable.command, executable.args) ?? executable;
	const created = await ctx.manager.create(executable.command, {
		command: launch.command,
		args: [...launch.args],
		cwd: request.cwd ?? ctx.cwd,
		env: { ...ctx.getEnv(), ...request.envOverrides } as Record<string, string | undefined>,
		cols: request.cols,
		rows: request.rows,
		timeoutMs: request.timeoutMs,
		redactSecretsInOutput: ctx.redactSecretsInOutput,
	});

	const spawnedPid = created.runtime.session.pid;
	if (request.sessionId !== undefined && spawnedPid !== undefined) {
		const attestation = attestSessionSpawn(request.sessionId, spawnedPid);
		created.runtime.session.onExit(() => void attestation.release());
		await attestation.recorded;
	}
	if (ctx.launchBarrier !== undefined) {
		const session = created.runtime.session;
		try {
			await ctx.launchBarrier.release({
				pid: session.pid,
				write: (data) => session.write(data),
				onExit: (listener) => session.onExit(() => listener(session.exitResult?.exitCode ?? null)),
			});
		} catch (error) {
			// The command never ran: its gated shim and its registration go with the refusal.
			await ctx.manager.stop(created.id);
			throw error;
		}
	}
	if (useStdin) {
		created.runtime.session.write(`${request.command}\n`);
	}
	if (request.testRun !== undefined) trackTestRun(created.runtime, request.testRun);
	return created;
}

function trackTestRun(runtime: CreatedTerminalSession["runtime"], run: PreparedTestRun): void {
	const finish = () => {
		unsubscribeDispose();
		try {
			runtime.testSummary = run.finish(runtime.exitResult);
		} finally {
			run.dispose();
		}
	};
	const unsubscribeExit = runtime.session.onExit(finish);
	const unsubscribeDispose = runtime.onDispose(() => {
		unsubscribeExit();
		run.dispose();
	});
}

export function testSummaryFor(runtime: TerminalExitView): TestSummary | undefined {
	return runtime.testSummary;
}

/** Snapshot the human-facing exit status of a finished session. */
export function describeExit(runtime: Pick<TerminalExitView, "exitResult">): string | null {
	const exit = runtime.exitResult;
	if (!exit) return null;
	if (exit.timedOut) return "timed_out";
	if (exit.cancelled) return "killed";
	if (exit.exitCode === 0) return "completed";
	if (exit.exitCode !== null) return `exited_${exit.exitCode}`;
	if (exit.signal) return `signal_${exit.signal}`;
	return "exited";
}
