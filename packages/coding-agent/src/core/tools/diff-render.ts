import * as Diff from "diff";
import { getLanguageFromPath, highlightCode } from "../../modes/interactive/theme/theme.ts";

export type ToolDiffThemeColor = "muted" | "toolDiffAdded" | "toolDiffContext" | "toolDiffRemoved";
export type ToolDiffThemeBg = "toolErrorBg" | "toolSuccessBg";

export type ToolDiffTheme = {
	fg: (name: ToolDiffThemeColor, text: string) => string;
	bg: (name: ToolDiffThemeBg, text: string) => string;
	inverse: (text: string) => string;
};

export type RenderToolDiffOptions = {
	filePath?: string;
	theme: ToolDiffTheme;
	contextContentColor?: "muted";
	inputFormat?: "compact" | "unified";
};

type RenderableAddedDiffLine = { content: string; kind: "added"; lineNumber: string; sign: "+" };
type RenderableRemovedDiffLine = { content: string; kind: "removed"; lineNumber: string; sign: "-" };
type RenderableContextDiffLine = { content: string; kind: "context"; lineNumber: string; sign: " " };
type RenderableContentDiffLine = RenderableAddedDiffLine | RenderableContextDiffLine | RenderableRemovedDiffLine;
type RenderableDiffLine = RenderableContentDiffLine | { kind: "meta"; text: string };
type UnifiedHunk = {
	oldLine: number;
	newLine: number;
	oldRemaining: number;
	newRemaining: number;
};

function parseRenderableDiffLine(line: string): RenderableDiffLine {
	const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
	if (!match) return { kind: "meta", text: line };

	const sign = match[1];
	const lineNumber = match[2];
	if ((sign !== "+" && sign !== "-" && sign !== " ") || lineNumber === undefined) return { kind: "meta", text: line };

	const content = match[3] ?? "";
	if (sign === "+") return { content, kind: "added", lineNumber, sign };
	if (sign === "-") return { content, kind: "removed", lineNumber, sign };
	return { content, kind: "context", lineNumber, sign };
}

function parseUnifiedDiff(diffText: string): RenderableDiffLine[] {
	let hunk: UnifiedHunk | undefined;
	return diffText.split("\n").map((line): RenderableDiffLine => {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		const oldStart = header?.[1];
		const newStart = header?.[3];
		if (header && oldStart !== undefined && newStart !== undefined) {
			hunk = {
				oldLine: Number(oldStart),
				newLine: Number(newStart),
				oldRemaining: Number(header[2] ?? "1"),
				newRemaining: Number(header[4] ?? "1"),
			};
			return { kind: "meta", text: line };
		}
		if (!hunk) return { kind: "meta", text: line };

		let parsed: RenderableDiffLine;
		switch (line[0]) {
			case " ":
				parsed = { content: line.slice(1), kind: "context", lineNumber: String(hunk.oldLine), sign: " " };
				hunk.oldLine++;
				hunk.newLine++;
				hunk.oldRemaining--;
				hunk.newRemaining--;
				break;
			case "-":
				parsed = { content: line.slice(1), kind: "removed", lineNumber: String(hunk.oldLine), sign: "-" };
				hunk.oldLine++;
				hunk.oldRemaining--;
				break;
			case "+":
				parsed = { content: line.slice(1), kind: "added", lineNumber: String(hunk.newLine), sign: "+" };
				hunk.newLine++;
				hunk.newRemaining--;
				break;
			default:
				return { kind: "meta", text: line };
		}
		if (hunk.oldRemaining === 0 && hunk.newRemaining === 0) hunk = undefined;
		return parsed;
	});
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, filePath: string | undefined): string {
	const plainContent = replaceTabs(content);
	if (!filePath) return plainContent;
	const language = getLanguageFromPath(filePath);
	try {
		return highlightCode(plainContent, language)[0] ?? plainContent;
	} catch {
		return plainContent;
	}
}

function renderInlineDiff(
	oldContent: string,
	newContent: string,
	theme: ToolDiffTheme,
): { added: string; removed: string } {
	const parts = Diff.diffWords(replaceTabs(oldContent), replaceTabs(newContent));
	let added = "";
	let removed = "";
	let firstAdded = true;
	let firstRemoved = true;

	for (const part of parts) {
		if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				added += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstAdded = false;
			}
			if (value) added += theme.inverse(value);
			continue;
		}

		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				removed += leadingWhitespace;
				value = value.slice(leadingWhitespace.length);
				firstRemoved = false;
			}
			if (value) removed += theme.inverse(value);
			continue;
		}

		added += part.value;
		removed += part.value;
	}

	return { added, removed };
}

function renderToolDiffLine(
	line: RenderableContentDiffLine,
	options: RenderToolDiffOptions,
	contentOverride?: string,
): string {
	const { filePath, theme, contextContentColor } = options;
	const unified = options.inputFormat === "unified";
	const lineNumber = unified ? "" : theme.fg("muted", line.lineNumber);
	const separator = unified ? "" : " ";
	if (line.kind === "context") {
		const content = highlightDiffContent(line.content, filePath);
		return `${theme.fg("toolDiffContext", line.sign)}${lineNumber}${separator}${
			contextContentColor === "muted" ? theme.fg("muted", content) : content
		}`;
	}

	const diffColor = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	const background = line.kind === "added" ? "toolSuccessBg" : "toolErrorBg";
	const content =
		contentOverride === undefined
			? highlightDiffContent(line.content, filePath)
			: theme.fg(diffColor, replaceTabs(contentOverride));
	const rendered = `${theme.fg(diffColor, line.sign)}${lineNumber}${separator}${content}`;
	return theme.bg(background, rendered);
}

export function countDiffChanges(diffText: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function renderToolDiff(diffText: string, options: RenderToolDiffOptions): string {
	const parsedLines =
		options.inputFormat === "unified"
			? parseUnifiedDiff(diffText)
			: diffText.split("\n").map(parseRenderableDiffLine);
	const rendered: string[] = [];
	let index = 0;

	while (index < parsedLines.length) {
		const line = parsedLines[index];
		if (!line) {
			index++;
			continue;
		}

		if (line.kind !== "removed") {
			rendered.push(
				line.kind === "meta" ? options.theme.fg("toolDiffContext", line.text) : renderToolDiffLine(line, options),
			);
			index++;
			continue;
		}

		const removedLines: RenderableRemovedDiffLine[] = [];
		while (parsedLines[index]?.kind === "removed") {
			const removedLine = parsedLines[index];
			if (removedLine?.kind === "removed") removedLines.push(removedLine);
			index++;
		}

		const addedLines: RenderableAddedDiffLine[] = [];
		while (parsedLines[index]?.kind === "added") {
			const addedLine = parsedLines[index];
			if (addedLine?.kind === "added") addedLines.push(addedLine);
			index++;
		}

		const pairedCount = Math.min(removedLines.length, addedLines.length);
		for (let pairIndex = 0; pairIndex < pairedCount; pairIndex++) {
			const removedLine = removedLines[pairIndex];
			const addedLine = addedLines[pairIndex];
			if (!removedLine || !addedLine) continue;

			const inline = renderInlineDiff(removedLine.content, addedLine.content, options.theme);
			rendered.push(renderToolDiffLine(removedLine, options, inline.removed));
			rendered.push(renderToolDiffLine(addedLine, options, inline.added));
		}

		for (const removedLine of removedLines.slice(pairedCount))
			rendered.push(renderToolDiffLine(removedLine, options));
		for (const addedLine of addedLines.slice(pairedCount)) rendered.push(renderToolDiffLine(addedLine, options));
	}

	return rendered.join("\n");
}
