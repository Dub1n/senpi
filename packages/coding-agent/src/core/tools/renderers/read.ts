/**
 * Presentation for the read tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `read.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type DensityCardStructuredView,
	type DensityCardView,
	sanitizeTerminalLabel,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getReadmePath } from "../../../config.ts";
import { keyHint, keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import { defaultToolCardIcon, prefixToolCardTitle } from "../../default-tool-card-title.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { TSchema } from "typebox";
import { resolveToCwd } from "../path-utils.ts";
import type { ReadToolDetails } from "../read.ts";
import { type CompactReadClassification, classifyRead } from "../read-classifiers.ts";
import { getTextOutput, linkPath, renderToolPath, replaceTabs, shortenPath, str } from "../render-utils.ts";
import { getSkillReadPath } from "./skill-read-path.ts";

/**
 * Classifications are memoized per tool call (unclaimed paths included) so a redraw or an
 * expand/collapse cannot pick a different headline for the same read.
 */
export interface ReadRenderState {
	classifications?: Map<string | null, CompactReadClassification | undefined>;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
export type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };
function readRenderArgs(args: unknown): ReadRenderArgs | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	return {
		...("path" in args && typeof args.path === "string" ? { path: args.path } : {}),
		...("file_path" in args && typeof args.file_path === "string" ? { file_path: args.file_path } : {}),
		...("offset" in args && typeof args.offset === "number" && Number.isSafeInteger(args.offset)
			? { offset: args.offset }
			: {}),
		...("limit" in args && typeof args.limit === "number" && Number.isSafeInteger(args.limit)
			? { limit: args.limit }
			: {}),
	};
}

function formatReadLineRange(args: ReadRenderArgs | undefined): string {
	// Strict tool schemas make models send null for omitted optional fields.
	if (args?.offset == null && args?.limit == null) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit != null ? startLine + args.limit - 1 : "";
	return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string, icon: string | undefined): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const skillPath = rawPath ? getSkillReadPath(resolveToCwd(rawPath, cwd), cwd) : undefined;
	const pathDisplay =
		rawPath && skillPath
			? linkPath(theme.fg("accent", skillPath), rawPath, cwd)
			: renderToolPath(rawPath, theme, cwd);
	return `${theme.fg("toolTitle", theme.bold(prefixToolCardTitle("read", icon)))} ${pathDisplay}${theme.fg("warning", formatReadLineRange(args))}`;
}

function readDensityHeading(
	args: ReadRenderArgs | undefined,
	cwd: string,
	classification: CompactReadClassification | undefined,
	viewed = false,
): Pick<DensityCardStructuredView, "kind" | "heading" | "expandedHeading"> {
	const path = args?.file_path ?? args?.path ?? "";
	if (viewed) {
		const label = (value: string, role?: "dim" | "muted") =>
			path
				? [
						{
							text: sanitizeTerminalLabel(value),
							...(role ? { role } : {}),
							link: pathToFileURL(resolveToCwd(path, cwd)).href,
						},
					]
				: "…";
		return {
			kind: "viewed",
			heading: { details: [label(basename(path))] },
			expandedHeading: { details: [label(shortenPath(path), "dim")] },
		};
	}
	const skill = classification?.kind === "skill" ? classification.label : undefined;
	const name = skill === undefined ? "read" : "skill";
	const label = (value: string) =>
		path ? [{ text: sanitizeTerminalLabel(value), link: pathToFileURL(resolveToCwd(path, cwd)).href }] : "…";
	return {
		kind: name,
		heading: { details: [label(skill ?? basename(path))] },
		expandedHeading: { details: [label(`${skill ?? shortenPath(path)}${formatReadLineRange(args)}`)] },
	};
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}
function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}
/** The compact headline a collapsed read card shows for these args, or undefined for a plain file read. */
export function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const registeredClassification = classifyRead({ absolutePath, cwd });
	if (registeredClassification) return registeredClassification;

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
	icon: string | undefined,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m${prefixToolCardTitle("[skill]", icon)}\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			theme.fg("warning", formatReadLineRange(args)) +
			expandHint
		);
	}

	if (classification.kind === "memory") {
		return (
			theme.fg("accent", `\x1b[1m${icon ?? "✦"} ${classification.headline ?? "Recalled"}\x1b[22m`) +
			" " +
			theme.fg("customMessageText", classification.label) +
			theme.fg("warning", formatReadLineRange(args)) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(prefixToolCardTitle(`read ${classification.kind}`, icon))) +
		" " +
		theme.fg("accent", classification.label) +
		theme.fg("warning", formatReadLineRange(args)) +
		expandHint
	);
}
export const readRenderers = {
	renderCall(rawArgs: unknown, theme, context) {
		const args = readRenderArgs(rawArgs);
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const classify = () => readClassification(args, context);
		const classification = context.expanded ? undefined : classify();
		const icon = defaultToolCardIcon(context, () => {
			const kind = (classification ?? classify())?.kind;
			return { kind: kind === "memory" || kind === "skill" ? kind : "read" };
		});
		text.setText(
			classification
				? formatCompactReadCall(classification, args, theme, icon)
				: formatReadCall(args, theme, context.cwd, icon),
		);
		return Object.assign(text, {
			renderDensityCard(): DensityCardView | undefined {
				if (context.hasResult) return undefined;
				return {
					format: "structured",
					...readDensityHeading(args, context.cwd, classify()),
					status: context.executionStarted ? "running" : "pending",
					body: [],
					sections: [],
				};
			},
		});
	},
	renderResult(result, { expanded, isPartial }, theme, context) {
		const { cwd, showImages, imageProtocol, isError, executionStarted } = context;
		const args = readRenderArgs(context.args);
		const path = str(args?.file_path ?? args?.path);
		const image = result.content.find((part) => part.type === "image");
		const imageRows =
			!isError && image
				? [
						...(showImages && imageProtocol
							? []
							: [`viewed image file [${sanitizeTerminalLabel(image.mimeType)}]`]),
						...result.content.flatMap((part) => {
							if (part.type !== "text") return [];
							const rows = part.text.split(/\r?\n/u);
							// The image or its fallback replaces only the metadata line, not the Read diagnostics.
							if (rows[0]?.startsWith("Read image file [")) rows.shift();
							return rows.map(sanitizeTerminalLabel).filter(Boolean);
						}),
					]
				: [];
		let lines: string[] | undefined;
		let denseLines: string[] | undefined;
		function payload(dense = false): string[] {
			if (dense && denseLines) return denseLines;
			if (!dense && lines) return lines;
			const content = isError && image ? result.content.filter((part) => part.type !== "image") : result.content;
			const outputText = getTextOutput({ content }, showImages);
			const raw = replaceTabs(outputText);
			const output = dense ? raw.replace(/(?:\n[^\S\n]*)+$/u, "").replace(/^[^\S\n]*$/u, "") : raw;
			const lang = !isError && path ? getLanguageFromPath(path) : undefined;
			const rendered = lang
				? highlightCode(output, lang, dense && lang === "markdown" ? "text" : undefined)
				: output.split("\n").map((line) => line && theme.fg(dense && !isError ? "text" : "toolOutput", line));
			if (dense) denseLines = rendered;
			else lines = rendered;
			return rendered;
		}

		let defaultText: Text | undefined;
		return {
			render(width: number) {
				if (!expanded && !isError) return [];
				if (!isError && image) {
					if (imageRows.length === 0) return [];
					defaultText ??= new Text(imageRows.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0);
					return defaultText.render(width);
				}
				if (!defaultText) {
					const rows = payload();
					let end = rows.length;
					while (end > 0 && rows[end - 1] === "") end--;
					const shown = expanded ? end : Math.min(end, 10);
					const body = rows.slice(0, shown).join("\n");
					if (!body && end === 0) return [];
					let text = `${body ? "\n" : ""}${body}`;
					if (end > shown) {
						text += `${theme.fg("muted", `\n... (${end - shown} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
					}
					defaultText = new Text(text, 0, 0);
				}
				return defaultText.render(width);
			},
			invalidate() {
				lines = undefined;
				denseLines = undefined;
				defaultText = undefined;
			},
			renderDensityCard(): DensityCardView | undefined {
				if (!isError && image) {
					const status = isPartial ? (executionStarted ? "running" : "pending") : "done";
					const statusGlyph = defaultToolCardIcon(context, { kind: "viewed", status });
					return {
						format: "structured",
						...readDensityHeading(args, cwd, undefined, true),
						...(statusGlyph === undefined ? {} : { statusGlyph }),
						status,
						body: expanded && imageRows.length > 0 ? [{ type: "text", lines: imageRows }] : [],
						sections: [],
					};
				}
				return {
					format: "structured",
					...readDensityHeading(args, cwd, readClassification(args, context)),
					status: isError ? "failed" : isPartial ? (executionStarted ? "running" : "pending") : "done",
					body: [{ type: "rich", render: (width) => wrapTextWithAnsi(payload(true).join("\n"), width) }],
					sections: [],
				};
			},
		};
	},
} satisfies Pick<ToolDefinition<TSchema, ReadToolDetails | undefined, ReadRenderState>, "renderCall" | "renderResult">;

function readClassification(
	args: ReadRenderArgs | undefined,
	context: { readonly cwd: string; readonly state: ReadRenderState },
): CompactReadClassification | undefined {
	const path = str(args?.file_path ?? args?.path);
	const classifications = (context.state.classifications ??= new Map());
	if (!classifications.has(path)) classifications.set(path, getCompactReadClassification(args, context.cwd));
	return classifications.get(path);
}
