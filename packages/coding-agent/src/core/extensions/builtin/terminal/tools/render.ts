import {
	type DensityCardSource,
	type DensityCardStructuredView,
	sanitizeTerminalLabel,
	Text,
} from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../../../modes/interactive/components/visual-truncate.ts";
import { isModelOnlyText } from "../../../../tools/model-only-text.ts";
import { formatJobWidgetLine, type JobWidgetLineStyle, jobWidgetLineStyle } from "../../job-widgets/tui-line.ts";
import type { JobWidgetEntry } from "../../job-widgets/view-types.ts";
import type { AgentToolResult, ToolDefinition } from "../../../types.ts";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";
import type { MonitorInput, monitorSchema } from "./monitor.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputViewDetails = {
	readonly sessionId: string;
	readonly processStatus: string;
	readonly exitCode: number | null;
	readonly statusStart: number;
	readonly statusEnd: number;
};
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type MonitorToolDefinition = ToolDefinition<typeof monitorSchema, BashOutputDetails>;
type RenderCallContext = Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[2];
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];

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

	constructor(text: string, sessionId: string, context?: RenderCallContext) {
		super(text, 0, 0);
		this.#sessionId = sessionId;
		this.#status = context?.executionStarted ? "running" : "pending";
	}

	renderDensityCard(): DensityCardStructuredView {
		return {
			format: "structured",
			kind: "bash-output",
			heading: bashHeading(this.#sessionId),
			status: this.#status,
			sections: [],
			body: [],
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

	setResult(
		result: AgentToolResult<BashOutputDetails>,
		options: RenderResultOptions,
		style: JobWidgetLineStyle,
		isError: boolean,
		sessionId: string | undefined,
	): void {
		this.#jobWidget = jobWidgetOf(result.details);
		this.#style = style;
		this.#text = result.content
			.filter((content) => content.type === "text" && !isModelOnlyText(content))
			.map((content) => (content.type === "text" ? content.text : ""))
			.join("\n");
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
		this.#isError = isError;
		this.#sessionId = sessionId;
		this.#bashOutput =
			bashOutputOf(result.details) ??
			(!isError && sessionId
				? legacyProcessHeader(this.#text, sessionId, result.details?.monitorMuted === true)
				: undefined);
	}

	renderDensityCard(): DensityCardStructuredView {
		const view = this.#bashOutput;
		const status = this.#isError ? "failed" : this.#isPartial ? "running" : view ? "done" : undefined;
		const details =
			view && !this.#isError
				? [
						sanitizeTerminalLabel(view.processStatus),
						...(view.exitCode === null ? [] : [`exit_code: ${view.exitCode}`]),
					]
				: [];
		// Hide only the status line by its producer-owned boundaries. The visible result still
		// owns the output, so history does not persist another copy or restore model-only notices.
		const hasBoundary =
			view &&
			(view.statusEnd === this.#text.length || this.#text[view.statusEnd] === "\n") &&
			(view.statusStart === 0 || this.#text[view.statusStart - 1] === "\n");
		const output = hasBoundary
			? this.#text.slice(0, view.statusStart) + this.#text.slice(view.statusEnd + 1)
			: this.#text;

		return {
			format: "structured",
			kind: "bash-output",
			heading: bashHeading(view?.sessionId ?? this.#sessionId, details),
			...(status === undefined ? { statusGlyph: "❯" } : { status }),
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
		theme.fg("toolTitle", theme.bold(`bash_output ${args.bash_id}`)),
		args.bash_id,
		context,
	);
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
	component.setResult(result, options, jobWidgetLineStyle(theme), context.isError, context.args?.bash_id);
	return component;
}
