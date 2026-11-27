/**
 * Presentation for the ls tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `ls.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { type DensityCardStructuredView, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { defaultToolCardIcon, prefixToolCardTitle } from "../../default-tool-card-title.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { LsToolDetails } from "../ls.ts";
import { getTextOutput, renderToolPath, shortenPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type LsRenderArgs = { path?: string; limit?: number };

function lsRenderArgs(input: unknown): LsRenderArgs | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	return {
		...("path" in input && typeof input.path === "string" ? { path: input.path } : {}),
		...("limit" in input && typeof input.limit === "number" ? { limit: input.limit } : {}),
	};
}

function formatLsCall(args: LsRenderArgs | undefined, theme: Theme, cwd: string, icon: string | undefined): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold(prefixToolCardTitle("ls", icon)))} ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
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

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const lsRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs: unknown, theme, context) {
		const args = lsRenderArgs(rawArgs);
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsCall(args, theme, context.cwd, defaultToolCardIcon(context, { kind: "ls" })));
		return Object.assign(text, {
			renderDensityCard(): DensityCardStructuredView {
				const path = args?.path || ".";
				const details = [shortenPath(path), ...(args?.limit === undefined ? [] : [`limit ${args.limit}`])];
				return {
					format: "structured",
					kind: "ls",
					heading: { details },
					expandedHeading: {
						details: [path, ...(args?.limit === undefined ? [] : [`limit ${args.limit}`])],
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
		text.setText(formatLsResult(result as any, options, theme, context.showImages));
		return Object.assign(text, {
			renderDensityCard(): DensityCardStructuredView {
				const args = lsRenderArgs(context.args);
				const path = args?.path || ".";
				const output = getTextOutput(result, context.showImages).trim();
				const warnings: string[] = [];
				const entryLimit = result.details?.entryLimitReached;
				const truncation = result.details?.truncation;
				const entryCount =
					context.isError || output === "(empty directory)" ? undefined : output ? output.split("\n").length : 0;
				if (entryLimit) warnings.push(`${entryLimit} entries limit`);
				if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
				return {
					format: "structured",
					kind: "ls",
					heading: {
						details: [
							shortenPath(path),
							...(args?.limit === undefined ? [] : [`limit ${args.limit}`]),
							...(entryCount === undefined ? [] : [`${entryCount} ${entryCount === 1 ? "entry" : "entries"}`]),
						],
					},
					expandedHeading: {
						details: [
							path,
							...(args?.limit === undefined ? [] : [`limit ${args.limit}`]),
							...(entryCount === undefined ? [] : [`${entryCount} ${entryCount === 1 ? "entry" : "entries"}`]),
						],
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
