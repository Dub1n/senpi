import type { DensityCardStatus, DensityCardStructuredView, Theme } from "@code-yeongyu/senpi";
import { parseEvalTestSummary } from "./call-capture.ts";
import { renderAgentProgressEvents } from "./render-agent.ts";
import {
	type RenderEnvironment,
	renderAllVisualLines,
	renderNow,
	style,
	TOOL_CALL_PREVIEW_COUNT,
} from "./render-blocks.ts";
import { renderDensityCellCode } from "./render-cell.ts";
import { renderJsonOutputs } from "./render-detail.ts";
import { renderNestedToolCallLines, type NestedToolCallRenderOptions } from "./render-nested-tool-calls.ts";
import { formatThroughputBadge, renderStatusEvents } from "./render-status.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalListDetails, EvalToolDetails } from "./types.ts";
import type { ResultRenderContext } from "./render-blocks.ts";

export interface EvalDensityCardOptions {
	readonly details: EvalToolDetails | undefined;
	readonly output: string;
	readonly isPartial: boolean;
	readonly isError: boolean;
	readonly theme: Theme | undefined;
	readonly context: ResultRenderContext;
	readonly renderers?: NestedToolCallRenderOptions["renderers"];
	readonly list?: EvalListDetails;
}

export function createEvalDensityCard(options: EvalDensityCardOptions): DensityCardStructuredView {
	const { details, theme, context } = options;
	// Older persisted host errors can carry an empty details object rather than the current schema.
	const toolCalls = details?.toolCalls ?? [];
	const testSummaryCalls = toolCalls.flatMap((call, index) => {
		const testSummary = parseEvalTestSummary(call.testSummary);
		return testSummary === undefined
			? []
			: [
					`#${index + 1}: ${testSummary.passed} passed, ${testSummary.failed} failed, ${testSummary.skipped} skipped`,
				];
	});
	const foldedTestSummaries = testSummaryCalls.slice(-TOOL_CALL_PREVIEW_COUNT);
	const language =
		details?.language ??
		(context.args.action === "run" || context.args.action === undefined ? context.args.language : undefined);
	const firstCell = details?.cells?.[0];
	const args = context.args.action === "run" || context.args.action === undefined ? context.args : undefined;
	const description = details?.summary ?? args?.summary ?? firstCell?.summary;
	if (options.list !== undefined) {
		const cells = options.list.cells;
		const states = (["queued", "running", "detached", "completed", "failed", "cancelled"] as const).flatMap(
			(state) => {
				const count = cells.filter((cell) => cell.state === state).length;
				return count === 0 ? [] : [{ state, count }];
			},
		);
		const unit = cells.length === 1 ? "cell" : "cells";
		const only = states.length === 1 ? states[0] : undefined;
		const count = only
			? `${cells.length} ${only.state} ${unit}`
			: `${cells.length} ${unit}${states.length ? ` (${states.map(({ state, count: n }) => `${n} ${state}`).join(", ")})` : ""}`;
		return {
			format: "structured",
			kind: "eval",
			heading: { identity: "eval list", details: [count] },
			expandedHeading: { identity: "eval list" },
			status:
				options.isError || cells.some((cell) => cell.state === "failed")
					? "failed"
					: options.isPartial
						? "running"
						: cells.some((cell) => cell.state === "cancelled")
							? "cancelled"
							: "done",
			body: [
				{
					type: "rich",
					render: (width) => renderAllVisualLines(style(theme, "toolOutput", options.output), width),
				},
			],
			sections: [],
		};
	}
	const status = densityStatus(details, options.isPartial, options.isError);
	const metadata = (): string => {
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
		return parts.join(" · ");
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
	const sections: DensityCardStructuredView["sections"][number][] = [];
	const cellOutput = (details?.cells ?? [])
		.map((cell) => ({ text: cell.output.trimEnd(), error: cell.status === "error" }))
		.filter((cell) => cell.text.length > 0);
	const output = cellOutput.length > 0 ? undefined : options.output.trimEnd();
	if (cellOutput.length > 0 || (output?.length ?? 0) > 0) {
		sections.push({
			heading: { label: "output", role: "title" },
			placement: "frame",
			body: [
				{
					type: "rich",
					render: (width) =>
						cellOutput.length > 0
							? cellOutput.flatMap((cell) =>
									renderAllVisualLines(style(theme, cell.error ? "error" : "toolOutput", cell.text), width),
								)
							: renderAllVisualLines(style(theme, "toolOutput", output ?? ""), width),
				},
			],
		});
	} else if (details?.cells === undefined) {
		sections.push({
			heading: { label: "output", role: "title" },
			placement: "frame",
			body: [{ type: "text", role: "muted", lines: ["(no output)"] }],
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
			heading: { label: "status" },
			placement: "frame",
			body: [{ type: "rich", render: (width) => renderStatusEvents(nonAgentEvents, environment(width)) }],
		});
	}
	if (agentEvents.length > 0) {
		sections.push({
			heading: { label: "agents" },
			placement: "frame",
			body: [{ type: "rich", render: (width) => renderAgentProgressEvents(agentEvents, environment(width)) }],
		});
	}
	if ((details?.jsonOutputs?.length ?? 0) > 0) {
		sections.push({
			heading: { label: "display" },
			placement: "frame",
			body: [{ type: "rich", render: (width) => renderJsonOutputs(details?.jsonOutputs ?? [], environment(width)) }],
		});
	}
	if (toolCalls.length > 0) {
		const nestedOptions: NestedToolCallRenderOptions = {
			theme,
			cwd: context.cwd,
			expanded: true,
			density: "dense",
			...(options.renderers === undefined ? {} : { renderers: options.renderers }),
		};
		const shellOnly = toolCalls.every((call) => call.name === "bash");
		sections.push({
			heading: { label: shellOnly ? "commands" : "tool calls", role: "title" },
			placement: "grouped",
			body: [
				{
					type: "rich",
					render: (width, grouped) =>
						renderNestedToolCallLines(details, { ...nestedOptions, indent: grouped ? 0 : 2 }, width),
				},
			],
		});
	}
	return {
		format: "structured",
		kind: "eval",
		heading:
			description === undefined
				? {
						identity:
							context.args.action === "peek" || context.args.action === "stop"
								? `eval ${context.args.action}`
								: language === undefined
									? "eval"
									: `eval ${language}`,
					}
				: { description },
		status,
		body: [
			{ type: "text", role: "muted", lines: [metadata()] },
			{
				type: "rich",
				render: (width) => {
					const lines: string[] = [];
					for (const [index, cell] of (details?.cells ?? []).entries()) {
						if (index > 0) lines.push("");
						lines.push(...renderDensityCellCode(cell, environment(width)));
					}
					return lines;
				},
			},
		],
		sections,
		...(foldedTestSummaries.length === 0
			? {}
			: {
					foldedDetails: [
						...(testSummaryCalls.length > foldedTestSummaries.length
							? [`${testSummaryCalls.length - foldedTestSummaries.length} earlier test summaries`]
							: []),
						...foldedTestSummaries,
					],
				}),
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
