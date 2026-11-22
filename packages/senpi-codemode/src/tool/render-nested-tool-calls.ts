import type { Theme } from "@code-yeongyu/senpi";
import {
	appendLines,
	type RenderBlock,
	renderAllVisualLines,
	renderToolCall,
	style,
	TOOL_CALL_PREVIEW_COUNT,
} from "./render-blocks.ts";
import { toolCallRow, toolCallRows } from "./render-detail.ts";
import type { EvalToolDetails } from "./types.ts";
import { type NestedToolRenderers, renderToolCallWidget } from "./tool-widgets.ts";

export type NestedToolCallRenderOptions = {
	readonly theme: Theme | undefined;
	readonly cwd: string;
	readonly expanded: boolean;
	readonly indent?: number;
	readonly renderers?: (toolName: string) => NestedToolRenderers | undefined;
};

export function nestedToolCallBlock(
	details: EvalToolDetails | undefined,
	options: NestedToolCallRenderOptions,
): RenderBlock | undefined {
	if (options.theme === undefined || !details?.toolCalls.some((call) => call.args !== undefined)) return undefined;
	return { kind: "dynamic", render: (width) => renderNestedToolCallLines(details, options, width) };
}

export function renderNestedToolCallLines(
	details: EvalToolDetails | undefined,
	options: NestedToolCallRenderOptions,
	width: number,
): string[] {
	const calls = details?.toolCalls ?? [];
	const retainedCalls = options.expanded ? calls : calls.slice(-TOOL_CALL_PREVIEW_COUNT);
	const retainedRows = options.expanded
		? toolCallRows(details)
		: toolCallRows(details).slice(-TOOL_CALL_PREVIEW_COUNT);
	const skippedCount = calls.length - retainedCalls.length;
	const toolCallNoun = skippedCount === 1 ? "call" : "calls";
	const lines =
		options.expanded || skippedCount === 0
			? []
			: renderAllVisualLines(style(options.theme, "muted", `${skippedCount} earlier tool ${toolCallNoun}`), width);
	const legacyBlock: Extract<RenderBlock, { kind: "toolCalls" }> = {
		kind: "toolCalls",
		calls: retainedRows,
		expanded: options.expanded,
		theme: options.theme,
	};
	for (const [index, call] of retainedCalls.entries()) {
		if (call.args !== undefined) {
			const removeWrapperIndent = options.indent === 0;
			const widgetLines = renderToolCallWidget(call, {
				cwd: options.cwd,
				theme: options.theme,
				expanded: options.expanded,
				width: width + (removeWrapperIndent ? 2 : 0),
				...(options.renderers ? { renderers: options.renderers } : {}),
			});
			appendLines(lines, removeWrapperIndent ? widgetLines.map((line) => line.slice(2)) : widgetLines);
		} else {
			appendLines(lines, renderToolCall(retainedRows[index] ?? toolCallRow(call), legacyBlock, width));
		}
	}
	return lines;
}
