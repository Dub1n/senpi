import {
	type DensityCardSource,
	type DensityCardView,
	sanitizeTerminalLabel,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "../../../../../modes/interactive/components/visual-truncate.ts";
import { isModelOnlyText } from "../../../../tools/model-only-text.ts";
import { formatJobWidgetLine, type JobWidgetLineStyle, jobWidgetLineStyle } from "../../job-widgets/tui-line.ts";
import type { JobWidgetEntry } from "../../job-widgets/view-types.ts";
import type { AgentToolResult, ToolDefinition } from "../../../types.ts";
import type { BashOutputInput, bashOutputSchema } from "./bash-output.ts";
import type { MonitorInput, monitorSchema } from "./monitor.ts";

type BashOutputDetails = Record<string, unknown> | undefined;
type BashOutputToolDefinition = ToolDefinition<typeof bashOutputSchema, BashOutputDetails>;
type MonitorToolDefinition = ToolDefinition<typeof monitorSchema, BashOutputDetails>;
type RenderCallContext = Parameters<NonNullable<BashOutputToolDefinition["renderCall"]>>[2];
type RenderResultOptions = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[1];
type RenderResultContext = Parameters<NonNullable<BashOutputToolDefinition["renderResult"]>>[3];

const OUTPUT_PREVIEW_LINES = 8;

// bash-output.ts has always put this producer-owned line before the output,
// or immediately after its optional monitor-muted notice.
const PROCESS_STATUS =
	/^status: (?:running|completed|killed|timed_out|exited(?:_-?\d+)?|signal_[A-Za-z0-9_]+)(?: exit_code: -?\d+)?$/;

function jobWidgetOf(details: BashOutputDetails): JobWidgetEntry | undefined {
	const entry = details?.jobWidget as JobWidgetEntry | undefined;
	return typeof entry?.view?.title === "string" && Array.isArray(entry.view.blocks) ? entry : undefined;
}

class BashOutputCallComponent extends Text implements DensityCardSource {
	readonly #status: "pending" | "running";

	constructor(text: string, context?: RenderCallContext) {
		super(text, 0, 0);
		this.#status = context?.executionStarted ? "running" : "pending";
	}

	renderDensityCard(): DensityCardView {
		return {
			name: "bash output",
			kind: "shell",
			title: "",
			status: this.#status,
			sections: [],
			renderContent: () => [],
		};
	}
}

class BashOutputResultComponent implements DensityCardSource {
	#text = "";
	#isPartial = false;
	#expanded = false;
	#jobWidget: JobWidgetEntry | undefined;
	#style: JobWidgetLineStyle | undefined;
	#bashId: string | undefined;
	#isError = false;
	#monitorMuted = false;

	setResult(
		result: AgentToolResult<BashOutputDetails>,
		options: RenderResultOptions,
		style: JobWidgetLineStyle,
		context: RenderResultContext,
	): void {
		this.#jobWidget = jobWidgetOf(result.details);
		this.#style = style;
		this.#text = result.content
			.filter((content) => content.type === "text" && !isModelOnlyText(content))
			.map((content) => (content.type === "text" ? content.text : ""))
			.join("\n");
		this.#isPartial = options.isPartial;
		this.#expanded = options.expanded;
		this.#bashId = context.args?.bash_id && sanitizeTerminalLabel(context.args.bash_id);
		this.#isError = context.isError;
		this.#monitorMuted = result.details?.monitorMuted === true;
	}

	renderDensityCard(): DensityCardView {
		const statusStart =
			this.#monitorMuted && this.#text.startsWith("monitor muted") ? this.#text.indexOf("\n") + 1 : 0;
		const statusEnd = this.#text.indexOf("\n", statusStart);
		const line = this.#text.slice(statusStart, statusEnd === -1 ? undefined : statusEnd);
		const processStatus = !this.#isError && PROCESS_STATUS.test(line) ? line : undefined;
		const status = this.#isError ? "failed" : this.#isPartial ? "running" : processStatus ? "done" : undefined;

		return {
			name: "bash output",
			kind: "shell",
			title: "",
			...(status === undefined ? { statusGlyph: "❯" } : { status }),
			sections: [],
			renderContent: (width) => {
				const first = processStatus && (this.#bashId ? `${this.#bashId} · ${processStatus}` : processStatus);
				const notice = processStatus && statusStart > 0 ? this.#text.slice(0, statusStart - 1) : "";
				const output = processStatus ? (statusEnd === -1 ? "" : this.#text.slice(statusEnd + 1)) : this.#text;
				return [
					...(first ? wrapTextWithAnsi(first, width) : []),
					...this.renderWidget(width),
					...(notice ? wrapTextWithAnsi(notice, width) : []),
					...(output ? wrapTextWithAnsi(output, width) : []),
				];
			},
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
	return new BashOutputCallComponent(theme.fg("toolTitle", theme.bold(`bash_output ${args.bash_id}`)), context);
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
	component.setResult(result, options, jobWidgetLineStyle(theme), context);
	return component;
}
