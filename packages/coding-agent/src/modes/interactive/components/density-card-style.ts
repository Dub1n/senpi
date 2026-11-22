import { extractAnsiCode, type DensityCardKind } from "@earendil-works/pi-tui";
import type { ToolDisplayColors } from "../../../core/settings-manager.ts";
import { theme, type ThemeColor } from "../theme/theme.ts";

const kindColors = {
	eval: "syntaxType",
	shell: "syntaxFunction",
	read: "syntaxVariable",
	todo: "syntaxKeyword",
	goal: "mdHeading",
	added: "error",
	edited: "toolTitle", // Matches the Default apply_patch preview's Edited header.
	deleted: "success",
	memory: "customMessageLabel",
	skill: "customMessageLabel",
	rules: "customMessageLabel",
	kibitz: "customMessageLabel",
	message: "customMessageLabel",
	task: "syntaxType",
	tool: "syntaxVariable",
	search: "mdLink",
	compaction: "customMessageLabel",
	system: "muted",
} as const satisfies Readonly<Record<DensityCardKind, ThemeColor>>;

type DensityTitle = {
	readonly name?: string | undefined;
	readonly detail: string;
	readonly glyph?: string | undefined;
};

/** Paint dense card chrome without inheriting any color from status or body text. */
export function densityCardStyle(colors: ToolDisplayColors, kind?: DensityCardKind) {
	const role = kind === undefined ? undefined : kindColors[kind];
	return {
		frame: (gutter: string) => theme.fg((colors.colorFrames && role) || "borderMuted", gutter),
		title: ({ name, detail, glyph }: DensityTitle) => {
			const marker = glyph ? `${glyph} ` : "";
			if (name === undefined) return marker + detail;
			const painted = theme.style(name, { fg: (colors.colorNames && role) || "toolTitle", bold: true });
			return marker + painted + neutralDetail(detail);
		},
	};
}

/** Retain only italic and strike from a semantic suffix, not its original color or weight. */
function neutralDetail(detail: string): string {
	let italic = false;
	let strikethrough = false;
	let text = "";
	let start = 0;
	for (let escape = detail.indexOf("\x1b"); escape !== -1; escape = detail.indexOf("\x1b", start)) {
		if (escape > start) text += theme.style(detail.slice(start, escape), { fg: "text", italic, strikethrough });
		const ansi = extractAnsiCode(detail, escape);
		start = escape + (ansi?.length ?? 1);
		const sgr = /^\x1b\[([0-9;:]*)m$/.exec(ansi?.code ?? "");
		if (!sgr) continue;
		const params = sgr[1].split(";");
		for (let index = 0; index < params.length; index++) {
			const code = params[index];
			if (code === "38" || code === "48" || code === "58") {
				// RGB / indexed color components are data, not style toggles.
				if (params[index + 1] === "2") index += 4;
				else if (params[index + 1] === "5") index += 2;
			} else if (code === "" || code === "0") {
				italic = false;
				strikethrough = false;
			} else if (code === "3" || code === "23") {
				italic = code === "3";
			} else if (code === "9" || code === "29") {
				strikethrough = code === "9";
			}
		}
	}
	return start < detail.length ? text + theme.style(detail.slice(start), { fg: "text", italic, strikethrough }) : text;
}
