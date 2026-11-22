/**
 * Presentation for the find tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `find.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { type DensityCardStructuredView, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { FindToolDetails } from "../find.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type FindRenderArgs = { pattern?: string; path?: string; limit?: number };

function findRenderArgs(input: unknown): FindRenderArgs | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	return {
		...("pattern" in input && typeof input.pattern === "string" ? { pattern: input.pattern } : {}),
		...("path" in input && typeof input.path === "string" ? { path: input.path } : {}),
		...("limit" in input && typeof input.limit === "number" ? { limit: input.limit } : {}),
	};
}

function formatFindCall(args: FindRenderArgs | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const findRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs: unknown, theme, context) {
		const args = findRenderArgs(rawArgs);
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindCall(args as any, theme));
		return Object.assign(text, {
			renderDensityCard(): DensityCardStructuredView {
				const pattern = str(args?.pattern);
				const path = str(args?.path) || ".";
				const details = [
					pattern ?? "",
					shortenPath(path),
					...(args?.limit === undefined ? [] : [`limit ${args.limit}`]),
				];
				return {
					format: "structured",
					kind: "find",
					heading: { details },
					expandedHeading: {
						details: [pattern ?? "", path, ...(args?.limit === undefined ? [] : [`limit ${args.limit}`])],
					},
					status: context.executionStarted ? "running" : "pending",
					body: [],
					sections: [],
				};
			},
		});
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindResult(result as any, options, theme, context.showImages));
		return Object.assign(text, {
			renderDensityCard(): DensityCardStructuredView {
				const args = findRenderArgs(context.args);
				const pattern = args?.pattern ?? "";
				const path = args?.path || ".";
				const output = getTextOutput(result, context.showImages).trim();
				const warnings: string[] = [];
				const resultLimit = result.details?.resultLimitReached;
				const truncation = result.details?.truncation;
				if (resultLimit) warnings.push(`${resultLimit} results limit`);
				if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
				const details = [pattern, shortenPath(path), ...(args?.limit === undefined ? [] : [`limit ${args.limit}`])];
				return {
					format: "structured",
					kind: "find",
					heading: { details },
					expandedHeading: {
						details: [pattern, path, ...(args?.limit === undefined ? [] : [`limit ${args.limit}`])],
					},
					status: context.isError ? "failed" : options.isPartial ? "running" : "done",
					...(warnings.length > 0
						? { foldedDetails: [theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)] }
						: {}),
					body: output ? [{ type: "text", lines: output.split("\n") }] : [],
					sections: [],
				};
			},
		});
	},
};
