import { type Static, Type } from "typebox";
import { getJobWidgetState } from "../../job-widgets/session-host.ts";
import type { JobWidgetEntry } from "../../job-widgets/view-types.ts";
import { formatTerminalToolOutput, sanitizeTerminalOutput } from "../output-format.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import { safeRegExp, TERMINAL_OUTPUT_TOOL } from "../shared.ts";
import {
	noticedResult,
	resolveTerminalId,
	type TerminalToolContext,
	type TerminalToolResult,
	textResult,
} from "./context.ts";
import { renderBashOutputCall, renderBashOutputResult } from "./render.ts";
import { describeExit, testSummaryFor } from "./spawn.ts";

export const bashOutputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	filter: Type.Optional(
		Type.String({
			description:
				"Only return output lines matching this regex. An invalid regex is ignored and the whole unfiltered output comes back.",
		}),
	),
	view: Type.Optional(
		Type.Union([Type.Literal("log"), Type.Literal("screen")], {
			description: "'log' returns new raw output (default); 'screen' returns the rendered xterm grid.",
		}),
	),
});

export type BashOutputInput = Static<typeof bashOutputSchema>;

function applyFilter(text: string, filter: string | undefined): string {
	if (!filter) return text;
	const regex = safeRegExp(filter);
	if (regex === null) return text;
	return text
		.split("\n")
		.filter((line) => regex.test(line))
		.join("\n");
}

/** The job's widget as of this read, when it has a live (or finished) chart to summarize. */
function jobWidgetOf(ctx: TerminalToolContext, id: string): JobWidgetEntry | undefined {
	const sessionKey = ctx.getSessionContext?.()?.sessionManager?.getSessionId?.();
	if (sessionKey === undefined) return undefined;
	const entry = getJobWidgetState(sessionKey)?.jobs.find((job) => job.id === id);
	return entry?.view && (entry.state === "live" || entry.state === "done") ? entry : undefined;
}

function screenView(runtime: TerminalRuntimeSession): string {
	const snapshot = runtime.snapshot();
	return snapshot.visibleGrid.join("\n").replace(/\s+$/, "");
}

export function createBashOutputTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_OUTPUT_TOOL,
		label: "bash_output",
		description:
			"Read output from a background bash session without blocking: new output since the last read, the status line, or a rendered full-screen snapshot via view:'screen'. Pattern watches run through monitor; completion arrives as a notification carrying the exit code and output tail.",
		promptSnippet:
			"Peek at background bash session output (filter, screen view, status); watch patterns with monitor, completion arrives as a notification",
		parameters: bashOutputSchema,
		async execute(_toolCallId: string, input: BashOutputInput): Promise<TerminalToolResult> {
			const sessionId = resolveTerminalId(ctx.manager, input.bash_id);
			const runtime = ctx.manager.get(sessionId);
			if (!runtime)
				return textResult(`No terminal session found with id: ${input.bash_id}`, {
					isError: true,
					details: { bashOutputError: { kind: "session-not-found", bashId: input.bash_id } },
				});

			const monitorEntry = ctx.monitorRegistry?.snapshot().find((entry) => entry.id === sessionId);
			const muted = monitorEntry?.paused === true;
			const mutedDropped = muted ? (ctx.monitorRegistry?.mutedDropped(sessionId) ?? 0) : 0;
			let mutedNote = "";
			if (muted) {
				mutedNote =
					mutedDropped > 0
						? `monitor muted - ${mutedDropped} line(s) dropped while muted; run monitor({ action: "rearm", bash_id: "${input.bash_id}" }) to resume.`
						: `monitor muted; run monitor({ action: "rearm", bash_id: "${input.bash_id}" }) to resume.`;
			}
			const jobWidget = jobWidgetOf(ctx, sessionId);
			const processStatus = runtime.exited ? (describeExit(runtime) ?? "exited") : "running";
			const exitCode = runtime.exited ? (runtime.exitResult?.exitCode ?? null) : null;
			const status = `status: ${processStatus}${exitCode === null ? "" : ` exit_code: ${exitCode}`}`;
			const prefix = mutedNote ? `${mutedNote}\n` : "";
			const header = `${prefix}${status}`;
			const pollNotices = {
				...(muted ? { monitorMuted: { dropped: mutedDropped } } : {}),
			};
			const details: Record<string, unknown> = {
				...(monitorEntry ? { monitorMuted: muted, mutedDropped } : {}),
				...(jobWidget ? { jobWidget } : {}),
				bashOutput: {
					sessionId,
					processStatus,
					exitCode,
					statusStart: prefix.length,
					statusEnd: header.length,
					view: input.view ?? "log",
					poll: { notices: pollNotices },
				},
			};

			if (input.view === "screen") {
				return textResult(`${header}\n${screenView(runtime)}`, { details });
			}
			const testSummary = testSummaryFor(runtime);
			if (testSummary !== undefined) details.testSummary = testSummary;

			const delta = runtime.readDelta();
			const filteredText = applyFilter(delta.text, input.filter);
			const formatted = formatTerminalToolOutput(filteredText);
			const droppedNotice = delta.droppedChars > 0 ? `[${delta.droppedChars} earlier chars dropped]` : undefined;
			const dropped = droppedNotice === undefined ? "" : `${droppedNotice}\n`;
			const emptyPlaceholder =
				formatted.body.length === 0
					? filteredText !== delta.text && sanitizeTerminalOutput(delta.text).trimEnd().length > 0
						? "filtered"
						: "synthetic"
					: formatted.body === "(no new output)"
						? "literal"
						: undefined;
			const bashOutput = details.bashOutput as Record<string, unknown>;
			details.bashOutput = {
				...bashOutput,
				poll: {
					...(emptyPlaceholder === undefined ? {} : { emptyPlaceholder }),
					notices: {
						...pollNotices,
						...(droppedNotice === undefined ? {} : { droppedOutput: { chars: delta.droppedChars } }),
						...(formatted.marker === undefined ? {} : { truncated: formatted.marker }),
					},
				},
			};
			return noticedResult(
				`${header}\n${dropped}${formatted.text || "(no new output)"}`,
				[droppedNotice, formatted.marker],
				{ details },
			);
		},
		renderCall: renderBashOutputCall,
		renderResult: renderBashOutputResult,
	};
}
