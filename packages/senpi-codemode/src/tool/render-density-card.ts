import type { DensityCardSection, DensityCardStatus, DensityCardView, Theme } from "@code-yeongyu/senpi";
import { sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import { renderAgentProgressEvents } from "./render-agent.ts";
import { type RenderEnvironment, renderAllVisualLines, renderNow, style } from "./render-blocks.ts";
import { renderDensityCellCode } from "./render-cell.ts";
import { renderJsonOutputs } from "./render-detail.ts";
import { renderNestedToolCallLines, type NestedToolCallRenderOptions } from "./render-nested-tool-calls.ts";
import { formatThroughputBadge, renderStatusEvents } from "./render-status.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalToolDetails } from "./types.ts";
import type { ResultRenderContext } from "./render-blocks.ts";

export interface EvalDensityCardOptions {
	readonly details: EvalToolDetails | undefined;
	readonly output: string;
	readonly isPartial: boolean;
	readonly isError: boolean;
	readonly theme: Theme | undefined;
	readonly context: ResultRenderContext;
	readonly renderers?: NestedToolCallRenderOptions["renderers"];
}

export function createEvalDensityCard(options: EvalDensityCardOptions): DensityCardView {
	const { details, theme, context } = options;
	// Older persisted host errors can carry an empty details object rather than the current schema.
	const toolCalls = details?.toolCalls ?? [];
	const language =
		details?.language ??
		(context.args.action === "run" || context.args.action === undefined ? context.args.language : undefined);
	const firstCell = details?.cells?.[0];
	const args = context.args.action === "run" || context.args.action === undefined ? context.args : undefined;
	const description =
		details?.summary ??
		args?.summary ??
		firstCell?.summary ??
		(language === undefined ? undefined : `eval ${language}`);
	const title = style(theme, "toolTitle", sanitizeTerminalLabel(description ?? "eval"));
	const status = densityStatus(details, options.isPartial, options.isError);
	const metadata = (width: number): readonly string[] => {
		const parts = [language === undefined ? "eval" : `eval ${language}`];
		const callCount = details?.toolCallCount ?? toolCalls.length;
		if (callCount > 0) {
			parts.push(
				formatThroughputBadge({
					calls: callCount,
					wallDurationMs: details?.wallDurationMs ?? details?.durationMs,
				}) ?? `${callCount} calls`,
			);
		}
		if (details?.runtime !== undefined && language !== undefined) {
			parts.push(`(${formatRuntimeBadge(language, details.runtime)})`);
		}
		if (details?.phase !== undefined) parts.push(`phase ${details.phase}`);
		const elapsedMs =
			options.isPartial && firstCell?.startedAt !== undefined
				? Math.max(0, renderNow(context) - firstCell.startedAt)
				: (details?.wallDurationMs ?? details?.durationMs);
		if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
		return renderAllVisualLines(style(theme, "muted", parts.join(" · ")), width);
	};
	const environment = (width: number): RenderEnvironment => ({
		expanded: true,
		theme,
		spinnerFrame: context.spinnerFrame,
		width,
		meta: details?.meta,
		now: renderNow(context),
		repaint: context.invalidate,
	});
	const sections: DensityCardSection[] = [];
	const cellOutput = (details?.cells ?? [])
		.map((cell) => ({ text: cell.output.trimEnd(), error: cell.status === "error" }))
		.filter((cell) => cell.text.length > 0);
	const output = cellOutput.length > 0 ? undefined : options.output.trimEnd();
	if (cellOutput.length > 0 || (output?.length ?? 0) > 0) {
		sections.push({
			label: "output",
			placement: "frame",
			render: (width) =>
				cellOutput.length > 0
					? cellOutput.flatMap((cell) =>
							renderAllVisualLines(style(theme, cell.error ? "error" : "toolOutput", cell.text), width),
						)
					: renderAllVisualLines(style(theme, "toolOutput", output ?? ""), width),
		});
	} else if (details?.cells === undefined) {
		sections.push({
			label: "output",
			placement: "frame",
			render: (width) => renderAllVisualLines(style(theme, "muted", "(no output)"), width),
		});
	}
	const statusEvents = [
		...(details?.statusEvents ?? []),
		...(details?.cells ?? []).flatMap((cell) => cell.statusEvents ?? []),
	];
	const nonAgentEvents = statusEvents.filter((event) => event.op !== "agent");
	const agentEvents = statusEvents.filter((event) => event.op === "agent");
	if (nonAgentEvents.length > 0) {
		sections.push({
			label: "status",
			placement: "frame",
			render: (width) => renderStatusEvents(nonAgentEvents, environment(width)),
		});
	}
	if (agentEvents.length > 0) {
		sections.push({
			label: "agents",
			placement: "frame",
			render: (width) => renderAgentProgressEvents(agentEvents, environment(width)),
		});
	}
	if ((details?.jsonOutputs?.length ?? 0) > 0) {
		sections.push({
			label: "display",
			placement: "frame",
			render: (width) => renderJsonOutputs(details?.jsonOutputs ?? [], environment(width)),
		});
	}
	if (toolCalls.length > 0) {
		const nestedOptions: NestedToolCallRenderOptions = {
			theme,
			cwd: context.cwd,
			expanded: true,
			...(options.renderers === undefined ? {} : { renderers: options.renderers }),
		};
		const shellOnly = toolCalls.every((call) => call.name === "bash");
		sections.push({
			label: shellOnly ? "commands" : "tool calls",
			placement: "grouped",
			render: (width, grouped) =>
				renderNestedToolCallLines(details, { ...nestedOptions, indent: grouped ? 0 : 2 }, width),
		});
	}
	return {
		title,
		status,
		renderMetadata: metadata,
		renderContent: (width) => {
			const lines: string[] = [];
			for (const [index, cell] of (details?.cells ?? []).entries()) {
				if (index > 0) lines.push("");
				lines.push(...renderDensityCellCode(cell, environment(width)));
			}
			return lines;
		},
		sections,
	};
}

function densityStatus(details: EvalToolDetails | undefined, isPartial: boolean, isError: boolean): DensityCardStatus {
	if (details?.isError || isError) return "failed";
	if (isPartial) return "running";
	const cells = details?.cells ?? [];
	if (cells.some((cell) => cell.status === "error")) return "failed";
	if (cells.some((cell) => cell.status === "cancelled")) return "cancelled";
	if (cells.some((cell) => cell.status === "detached")) return "detached";
	if (cells.some((cell) => cell.status === "queued")) return "queued";
	if (cells.some((cell) => cell.status === "running")) return "running";
	return "done";
}
