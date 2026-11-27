import {
	type DensityCardSource,
	type DensityCardStructuredView,
	sanitizeTerminalLabel,
	Text,
} from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../../../modes/interactive/components/visual-truncate.ts";
import { defaultToolCardTitle } from "../../../../default-tool-card-title.ts";
import { isModelOnlyText } from "../../../../tools/model-only-text.ts";
import { formatToolCallWithArgs, getTextOutput } from "../../../../tools/render-utils.ts";
import { formatJobWidgetLine, type JobWidgetLineStyle, jobWidgetLineStyle } from "../../job-widgets/tui-line.ts";
import type { JobWidgetEntry } from "../../job-widgets/view-types.ts";
import type { AgentToolResult, ToolDefinition } from "../../../types.ts";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";
import type { KillBashInput, killBashSchema } from "./kill-bash.ts";
import type { MonitorInput, monitorSchema } from "./monitor.ts";
import { testSummaryLabel } from "./test-summary.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputViewDetails = {
	readonly sessionId: string;
	readonly processStatus: string;
	readonly exitCode: number | null;
	readonly statusStart: number;
	readonly statusEnd: number;
};
export type DenseBashPollArgs = {
	readonly bash_id?: string;
	readonly view?: "log" | "screen";
	readonly filter?: string;
};
type DenseBashPollResult = {
	readonly content?: unknown;
	readonly details?: unknown;
	readonly isError?: unknown;
};
export type DenseBashPollView = {
	readonly sessionId: string;
	readonly processStatus: string;
	readonly exitCode: number | null;
	readonly status: "running" | "done" | "failed" | "cancelled";
	readonly exitKey: string;
	readonly body: string;
	readonly bodyFingerprint: string;
	readonly emptyPlaceholder?: "synthetic" | "filtered" | "literal";
	readonly notices: readonly string[];
	readonly testLabel?: string;
};
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type MonitorToolDefinition = ToolDefinition<typeof monitorSchema, BashOutputDetails>;
type KillBashToolDefinition = ToolDefinition<typeof killBashSchema, BashOutputDetails>;
type RenderCallContext = Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[2];
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];
type KillBashCallContext = Parameters<NonNullable<KillBashToolDefinition["renderCall"]>>[2];
type KillBashResultOptions = Parameters<NonNullable<KillBashToolDefinition["renderResult"]>>[1];
type KillBashResultContext = Parameters<NonNullable<KillBashToolDefinition["renderResult"]>>[3];

const OUTPUT_PREVIEW_LINES = 8;

function jobWidgetOf(details: BashOutputDetails): JobWidgetEntry | undefined {
	const entry = details?.jobWidget as JobWidgetEntry | undefined;
	return typeof entry?.view?.title === "string" && Array.isArray(entry.view.blocks) ? entry : undefined;
}

function bashOutputOf(details: BashOutputDetails): BashOutputViewDetails | undefined {
	const value = details?.bashOutput;
	if (
		typeof value !== "object" ||
		value === null ||
		!("sessionId" in value) ||
		!("processStatus" in value) ||
		!("exitCode" in value) ||
		!("statusStart" in value) ||
		!("statusEnd" in value) ||
		typeof value.sessionId !== "string" ||
		typeof value.processStatus !== "string" ||
		(value.exitCode !== null && typeof value.exitCode !== "number") ||
		typeof value.statusStart !== "number" ||
		typeof value.statusEnd !== "number" ||
		!Number.isSafeInteger(value.statusStart) ||
		!Number.isSafeInteger(value.statusEnd) ||
		value.statusStart < 0 ||
		value.statusEnd <= value.statusStart
	)
		return undefined;
	const { sessionId, processStatus, exitCode, statusStart, statusEnd } = value;
	return { sessionId, processStatus, exitCode, statusStart, statusEnd };
}

function visibleResultText(content: readonly unknown[]): string {
	return content
		.flatMap((part) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string" &&
			!isModelOnlyText(part)
				? [part.text]
				: [],
		)
		.join("\n");
}

function bodyAfterStatus(text: string, view: BashOutputViewDetails): string | undefined {
	const hasBoundary =
		(view.statusEnd === text.length || text[view.statusEnd] === "\n") &&
		(view.statusStart === 0 || text[view.statusStart - 1] === "\n");
	return hasBoundary ? (view.statusEnd === text.length ? "" : text.slice(view.statusEnd + 1)).trimEnd() : undefined;
}

function pollNoticeLabels(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	const notices: string[] = [];
	const monitor = "monitorMuted" in value ? value.monitorMuted : undefined;
	if (monitor !== null && typeof monitor === "object" && "dropped" in monitor) {
		const dropped = monitor.dropped;
		notices.push(
			typeof dropped === "number" && dropped > 0 ? `monitor muted; ${dropped} lines dropped` : "monitor muted",
		);
	}
	const dropped = "droppedOutput" in value ? value.droppedOutput : undefined;
	if (dropped !== null && typeof dropped === "object" && "chars" in dropped) {
		notices.push(
			typeof dropped.chars === "number" ? `${dropped.chars} earlier chars dropped` : "earlier output dropped",
		);
	}
	if ("truncated" in value && value.truncated !== undefined) notices.push("output truncated");
	return notices;
}

function processStatusDetail(view: Pick<BashOutputViewDetails, "processStatus" | "exitCode">): {
	statusGlyph: string;
	detail: string;
} {
	if (view.processStatus === "running") return { statusGlyph: "✓", detail: "running" };
	if (view.processStatus === "killed") return { statusGlyph: "×", detail: "killed" };
	if (view.processStatus === "timed_out") return { statusGlyph: "×", detail: "timed out" };
	if (view.processStatus.startsWith("signal_"))
		return { statusGlyph: "×", detail: `signal ${view.processStatus.slice("signal_".length)}` };
	if (view.exitCode !== null && view.exitCode !== 0) return { statusGlyph: "×", detail: `exit code ${view.exitCode}` };
	if (view.processStatus === "completed" || view.exitCode === 0) return { statusGlyph: "✓", detail: "completed" };
	const exitedCode = /^exited_(-?\d+)$/.exec(view.processStatus)?.[1];
	return {
		statusGlyph: "×",
		detail:
			exitedCode === undefined ? sanitizeTerminalLabel(view.processStatus) || "exited" : `exit code ${exitedCode}`,
	};
}

/**
 * Classify a stored bash_output result for dense presentation without parsing model-facing output.
 * Returns undefined when the result is an error, screen snapshot, or lacks trusted poll metadata.
 */
export function denseBashPoll(result: unknown, args: DenseBashPollArgs): DenseBashPollView | undefined {
	if (result === null || typeof result !== "object") return undefined;
	const stored = result as DenseBashPollResult;
	if (stored.isError === true || !Array.isArray(stored.content)) return undefined;
	const details =
		stored.details !== null && typeof stored.details === "object"
			? (stored.details as Record<string, unknown>)
			: undefined;
	const nested = details?.bashOutput;
	if (nested === null || typeof nested !== "object") return undefined;
	const value = nested as Record<string, unknown>;
	const sessionId = typeof value.sessionId === "string" ? value.sessionId : args.bash_id;
	if (!sessionId || args.view === "screen" || value.view === "screen") return undefined;
	const metadata = bashOutputOf(details);
	if (!metadata) return undefined;
	const poll = value.poll;
	if (poll === null || typeof poll !== "object") return undefined;
	const pollFacts = poll as Record<string, unknown>;
	if (
		pollFacts.emptyPlaceholder !== undefined &&
		pollFacts.emptyPlaceholder !== "synthetic" &&
		pollFacts.emptyPlaceholder !== "filtered" &&
		pollFacts.emptyPlaceholder !== "literal"
	)
		return undefined;
	const recoveredBody = bodyAfterStatus(visibleResultText(stored.content), metadata);
	if (recoveredBody === undefined) return undefined;
	const emptyPlaceholder = pollFacts.emptyPlaceholder;
	if (emptyPlaceholder !== undefined && recoveredBody !== "(no new output)") return undefined;
	const body =
		emptyPlaceholder === "synthetic"
			? "(no new output)"
			: emptyPlaceholder === "filtered"
				? "(no matching output)"
				: recoveredBody;
	const processStatus = metadata.processStatus;
	const exitCode = metadata.exitCode;
	const exitKey =
		processStatus === "running" ||
		processStatus === "completed" ||
		processStatus === "killed" ||
		processStatus === "timed_out"
			? processStatus
			: processStatus.startsWith("signal_")
				? processStatus
				: exitCode !== null && exitCode !== 0
					? `exit_code:${exitCode}`
					: processStatus;
	const status =
		processStatus === "running"
			? "running"
			: processStatus === "killed"
				? "cancelled"
				: processStatus === "completed" && (exitCode === null || exitCode === 0)
					? "done"
					: "failed";
	const testLabel =
		processStatus === "completed" || processStatus === "exited_1"
			? testSummaryLabel(details?.testSummary)
			: undefined;
	return {
		sessionId: metadata.sessionId,
		processStatus,
		exitCode,
		status,
		exitKey,
		body,
		bodyFingerprint: body,
		...(emptyPlaceholder === undefined
			? {}
			: { emptyPlaceholder: emptyPlaceholder as DenseBashPollView["emptyPlaceholder"] }),
		notices: pollNoticeLabels(pollFacts.notices),
		...(testLabel === undefined ? {} : { testLabel }),
	};
}

function bashHeading(sessionId: string | undefined, details: readonly string[] = []) {
	const id = sessionId && sanitizeTerminalLabel(sessionId);
	return {
		...(id ? { identity: /^bash_(\d+)$/.exec(id)?.[1] ?? id } : {}),
		details,
	};
}

/** Older persisted results lack boundaries; accept only the original producer's header at its known slot. */
function legacyProcessHeader(
	text: string,
	sessionId: string,
	monitorMuted: boolean,
): BashOutputViewDetails | undefined {
	const prefixEnd = monitorMuted && text.startsWith("monitor muted") ? text.indexOf("\n") : -1;
	const statusStart = prefixEnd + 1;
	const end = text.indexOf("\n", statusStart);
	const statusEnd = end === -1 ? text.length : end;
	const match =
		/^status: (running|completed|killed|timed_out|exited(?:_-?\d+)?|signal_[A-Za-z0-9_]+)(?: exit_code: (-?\d+))?$/.exec(
			text.slice(statusStart, statusEnd),
		);
	if (!match) return undefined;
	return {
		sessionId,
		processStatus: match[1],
		exitCode: match[2] === undefined ? null : Number(match[2]),
		statusStart,
		statusEnd,
	};
}

class BashOutputCallComponent extends Text implements DensityCardSource {
	readonly #status: "pending" | "running";
	readonly #sessionId: string;
	readonly #details: readonly string[];

	constructor(text: string, sessionId: string, executionStarted: boolean, details: readonly string[] = []) {
		super(text, 0, 0);
		this.#sessionId = sessionId;
		this.#status = executionStarted ? "running" : "pending";
		this.#details = details;
	}

	renderDensityCard(): DensityCardStructuredView {
		return {
			format: "structured",
			kind: "bash-output",
			heading: bashHeading(this.#sessionId, this.#details),
			status: this.#status,
			sections: [],
			body: [],
		};
	}
}

class KillBashResultComponent extends Text implements DensityCardSource {
	#text = "";
	#bodyText = "";
	#sessionId = "";
	#status: "running" | "done" | "failed" = "running";
	#detail = "killing";
	#outcome: string | undefined;
	#testLabel: string | undefined;

	setResult(
		result: AgentToolResult<BashOutputDetails>,
		options: KillBashResultOptions,
		context: KillBashResultContext,
		sessionId: string,
		theme: Parameters<NonNullable<KillBashToolDefinition["renderResult"]>>[2],
	): void {
		this.#text = getTextOutput(result, context.showImages);
		this.setText(theme.fg("toolOutput", this.#text));
		this.#sessionId = sessionId;
		const killBash = result.details?.killBash;
		this.#outcome =
			killBash !== null &&
			typeof killBash === "object" &&
			"sessionId" in killBash &&
			killBash.sessionId === sessionId &&
			"outcome" in killBash &&
			typeof killBash.outcome === "string"
				? killBash.outcome
				: undefined;
		const lines = this.#text.split("\n").filter((line) => line.trim() !== `bash_id: ${sessionId}`);
		const alreadyExited =
			this.#outcome === "already-exited" ||
			(context.isError && lines.join("\n") === `Could not kill ${sessionId}: session already exited.`);
		this.#testLabel = this.#outcome === "already-exited" ? testSummaryLabel(result.details?.testSummary) : undefined;
		const notFound = context.isError && lines.join("\n") === `No terminal session found with id: ${sessionId}`;
		this.#status =
			context.isError || this.#outcome === "failed" || alreadyExited
				? "failed"
				: options.isPartial
					? "running"
					: "done";
		this.#detail = alreadyExited
			? "already exited"
			: notFound
				? "session not found"
				: this.#status === "failed"
					? "failed"
					: options.isPartial
						? "killing"
						: "killed";
		if (this.#status === "failed") {
			this.#bodyText =
				this.#outcome === "already-exited"
					? `Could not kill ${sessionId}: session already exited.`
					: lines.join("\n");
			return;
		}
		this.#bodyText = lines.filter((line) => line.trim() !== `Killed ${sessionId}.`).join("\n");
	}

	renderDensityCard(): DensityCardStructuredView {
		const legacyAcknowledgment = this.#text.split("\n").includes(`Killed ${this.#sessionId}.`);
		const bodyText =
			this.#status === "done" &&
			(this.#outcome === "killed" || (legacyAcknowledgment && this.#bodyText.length === 0))
				? [`killed ${this.#sessionId}.`, ...(this.#bodyText.length > 0 ? this.#bodyText.split("\n") : [])].join(
						"\n",
					)
				: this.#bodyText;
		return {
			format: "structured",
			kind: "bash-output",
			heading: bashHeading(this.#sessionId, [this.#detail, ...(this.#testLabel ? [this.#testLabel] : [])]),
			status: this.#status,
			body: bodyText.length > 0 ? [{ type: "text", lines: bodyText.split("\n") }] : [],
			sections: [],
		};
	}
}

class BashOutputResultComponent implements DensityCardSource {
	#text = "";
	#isPartial = false;
	#expanded = false;
	#jobWidget: JobWidgetEntry | undefined;
	#style: JobWidgetLineStyle | undefined;
	#isError = false;
	#sessionId: string | undefined;
	#bashOutput: BashOutputViewDetails | undefined;
	#densePoll: DenseBashPollView | undefined;
	#testLabel: string | undefined;
	#pollNotices: readonly string[] = [];
	#lookupLabel: string | undefined;

	setResult(
		result: AgentToolResult<BashOutputDetails>,
		options: RenderResultOptions,
		style: JobWidgetLineStyle,
		isError: boolean,
		args: BashOutputInput | undefined,
	): void {
		this.#jobWidget = jobWidgetOf(result.details);
		this.#style = style;
		this.#text = visibleResultText(result.content);
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
		this.#isError = isError;
		this.#sessionId = args?.bash_id;
		const bashOutput = result.details?.bashOutput;
		const poll =
			bashOutput !== null && typeof bashOutput === "object" && "poll" in bashOutput ? bashOutput.poll : undefined;
		const pollNotices = poll !== null && typeof poll === "object" && "notices" in poll ? poll.notices : undefined;
		this.#pollNotices = pollNoticeLabels(
			pollNotices ??
				(result.details?.monitorMuted === true
					? { monitorMuted: { dropped: result.details.mutedDropped } }
					: undefined),
		);
		const outputError = result.details?.bashOutputError;
		this.#lookupLabel =
			outputError !== null &&
			typeof outputError === "object" &&
			"kind" in outputError &&
			outputError.kind === "session-not-found"
				? "session not found"
				: undefined;
		this.#bashOutput =
			bashOutputOf(result.details) ??
			(!isError && args?.bash_id
				? legacyProcessHeader(this.#text, args.bash_id, result.details?.monitorMuted === true)
				: undefined);
		this.#densePoll = denseBashPoll(result, args ?? {});
		const processStatus = bashOutputOf(result.details)?.processStatus;
		this.#testLabel =
			processStatus === "completed" || processStatus === "exited_1"
				? testSummaryLabel(result.details?.testSummary)
				: undefined;
	}

	renderDensityCard(): DensityCardStructuredView {
		const densePoll = this.#densePoll;
		if (densePoll) {
			const status = processStatusDetail(densePoll);
			return {
				format: "structured",
				kind: "bash-output",
				heading: bashHeading(densePoll.sessionId, [
					status.detail,
					...(densePoll.testLabel === undefined ? [] : [densePoll.testLabel]),
					...densePoll.notices,
				]),
				...(this.#isPartial ? { status: "running" as const } : { statusGlyph: status.statusGlyph }),
				body: [
					...(this.#jobWidget && this.#style
						? [{ type: "rich" as const, render: (width: number) => this.renderWidget(width) }]
						: []),
					...(densePoll.body.length > 0
						? [{ type: "text" as const, lines: densePoll.body.split("\n"), role: "muted" as const }]
						: []),
				],
				sections: [],
			};
		}
		const view = this.#bashOutput;
		const status = view ? processStatusDetail(view) : undefined;
		const details = status
			? [status.detail, ...(this.#testLabel ? [this.#testLabel] : []), ...this.#pollNotices]
			: [...(this.#lookupLabel === undefined ? [] : [this.#lookupLabel]), ...this.#pollNotices];
		const output = view ? (bodyAfterStatus(this.#text, view) ?? this.#text) : this.#text;

		return {
			format: "structured",
			kind: "bash-output",
			heading: bashHeading(view?.sessionId ?? this.#sessionId, details),
			...(this.#isPartial && !this.#isError
				? { status: "running" as const }
				: { statusGlyph: this.#isError || this.#lookupLabel !== undefined ? "✗" : (status?.statusGlyph ?? "❯") }),
			body: [
				...(this.#jobWidget && this.#style
					? [{ type: "rich" as const, render: (width: number) => this.renderWidget(width) }]
					: []),
				...(output.length > 0 ? [{ type: "text" as const, lines: output.split("\n") }] : []),
			],
			sections: [],
		};
	}

	private renderWidget(width: number): readonly string[] {
		const summary =
			this.#jobWidget && this.#style
				? formatJobWidgetLine(this.#jobWidget, width, this.#style, { showId: false })
				: undefined;
		return summary === undefined ? [] : [summary];
	}

	render(width: number): string[] {
		const output =
			!this.#isPartial || this.#expanded
				? this.#text.split("\n")
				: truncateToVisualLines(this.#text, OUTPUT_PREVIEW_LINES, Math.max(1, width)).visualLines.map((line) =>
						line.trimEnd(),
					);
		return [...this.renderWidget(width), ...output];
	}

	invalidate(): void {}
}

export function renderBashOutputCall(
	args: BashOutputInput,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[1],
	context?: RenderCallContext,
): Text {
	return new BashOutputCallComponent(
		theme.fg(
			"toolTitle",
			theme.bold(
				defaultToolCardTitle(`bash_output ${args.bash_id}`, context, (details) => {
					const metadata =
						details && typeof details === "object" && "bashOutput" in details
							? bashOutputOf({ bashOutput: details.bashOutput })
							: undefined;
					return { kind: "bash-output", ...(metadata && { glyph: processStatusDetail(metadata).statusGlyph }) };
				}),
			),
		),
		args.bash_id,
		context?.executionStarted ?? false,
	);
}

export function renderKillBashCall(
	args: KillBashInput,
	theme: Parameters<NonNullable<KillBashToolDefinition["renderCall"]>>[1],
	context: KillBashCallContext,
): Text | BashOutputCallComponent {
	const title = defaultToolCardTitle("kill_bash", context, { kind: "bash-output" });
	const call = formatToolCallWithArgs(title, args, theme, context.expanded);
	if (args.all === true || args.bash_id === undefined || args.bash_id.length === 0) return new Text(call, 0, 0);
	return new BashOutputCallComponent(call, args.bash_id, context.executionStarted, ["killing"]);
}

export function renderKillBashResult(
	result: AgentToolResult<BashOutputDetails>,
	options: KillBashResultOptions,
	theme: Parameters<NonNullable<KillBashToolDefinition["renderResult"]>>[2],
	context: KillBashResultContext,
): Text | KillBashResultComponent {
	const rawSessionId = context.args?.bash_id;
	const sessionId = typeof rawSessionId === "string" ? sanitizeTerminalLabel(rawSessionId) || undefined : undefined;
	if (context.args?.all === true || sessionId === undefined) {
		return new Text(theme.fg("toolOutput", getTextOutput(result, context.showImages)), 0, 0);
	}
	const component =
		(context.lastComponent as KillBashResultComponent | undefined) ?? new KillBashResultComponent("", 0, 0);
	component.setResult(result, options, context, sessionId, theme);
	return component;
}

export function renderMonitorCall(
	args: MonitorInput,
	theme: Parameters<NonNullable<MonitorToolDefinition["renderCall"]>>[1],
): Text {
	const label =
		args.action === "rearm"
			? `monitor rearm ${args.bash_id ?? ""}`.trimEnd()
			: `monitor ${args.description ?? args.command ?? ""}`.trimEnd();
	return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
}

export function renderBashOutputResult(
	result: AgentToolResult<BashOutputDetails>,
	options: RenderResultOptions,
	theme: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[2],
	context: Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[3],
): BashOutputResultComponent {
	const component =
		(context.lastComponent as BashOutputResultComponent | undefined) ?? new BashOutputResultComponent();
	component.setResult(result, options, jobWidgetLineStyle(theme), context.isError, context.args);
	return component;
}
