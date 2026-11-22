import {
	extractAnsiCode,
	getCapabilities,
	hyperlink,
	type DensityCardHeading,
	type DensityCardKind,
	type DensityCardText,
} from "@earendil-works/pi-tui";
import type { ToolDisplayColors } from "../../../core/settings-manager.ts";
import { theme, type ThemeColor } from "../theme/theme.ts";

type DensityCardPalette = {
	readonly name: string;
	readonly accent: ThemeColor;
	readonly frame: "accent" | "muted";
	readonly body: "text" | "muted";
	readonly section: "title" | "muted";
	readonly identityIsName?: boolean;
};

const cardRegistry = {
	eval: { name: "eval", accent: "syntaxType", frame: "muted", body: "muted", section: "muted", identityIsName: true },
	shell: { name: "bash", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	powershell: { name: "powershell", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	"bash-output": { name: "bash", accent: "syntaxFunction", frame: "accent", body: "muted", section: "muted" },
	wait: { name: "wait", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	wake: { name: "wake", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	read: { name: "read", accent: "syntaxVariable", frame: "accent", body: "text", section: "muted" },
	todo: { name: "todo", accent: "syntaxKeyword", frame: "accent", body: "text", section: "muted" },
	goal: { name: "goal", accent: "mdHeading", frame: "accent", body: "text", section: "muted" },
	edit: { name: "edit", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	write: { name: "write", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	added: { name: "added", accent: "error", frame: "accent", body: "text", section: "muted" },
	edited: { name: "edited", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	deleted: { name: "deleted", accent: "success", frame: "accent", body: "text", section: "muted" },
	memory: { name: "remembered", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	skill: { name: "skill", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	rules: { name: "rules", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	"project-rules": {
		name: "project rules",
		accent: "customMessageLabel",
		frame: "accent",
		body: "text",
		section: "muted",
	},
	kibitz: { name: "kibitz", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	message: { name: "message", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	"incoming-message": { name: "from", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	"outgoing-message": {
		name: "messaged",
		accent: "customMessageLabel",
		frame: "accent",
		body: "text",
		section: "muted",
	},
	task: { name: "task", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	"task-peek": { name: "peek", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	tool: { name: "tool", accent: "syntaxVariable", frame: "accent", body: "text", section: "muted" },
	search: { name: "search", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	find: { name: "find", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	grep: { name: "grep", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	ls: { name: "ls", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	compaction: { name: "compacted", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	system: { name: "system", accent: "muted", frame: "accent", body: "text", section: "muted" },
} as const satisfies Readonly<Record<DensityCardKind, DensityCardPalette>>;

type DensityTitle = {
	readonly name?: string | undefined;
	readonly detail: string;
	readonly glyph?: string | undefined;
};

/** Paint dense card chrome without inheriting any color from status or body text. */
export function densityCardStyle(colors: ToolDisplayColors, kind?: DensityCardKind) {
	const palette: DensityCardPalette | undefined = kind === undefined ? undefined : cardRegistry[kind];
	const role = palette?.accent;
	const nameColor = (colors.colorNames && role) || "toolTitle";
	return {
		frame: (gutter: string) =>
			theme.fg((palette?.frame === "accent" && colors.colorFrames && role) || "borderMuted", gutter),
		icon: (glyph: string) => theme.fg((colors.colorIcons && role) || "text", glyph),
		label: (label: string) => theme.style(label, { fg: nameColor, bold: true }),
		description: (label: string) => theme.fg("toolTitle", label),
		titleSection: (label: string, heading: DensityCardHeading) =>
			theme.style(label, { fg: heading.description === undefined ? nameColor : "toolTitle", bold: true }),
		bodyRole: palette?.body ?? "text",
		sectionRole: palette?.section ?? "muted",
		title: ({ name, detail, glyph }: DensityTitle) => {
			const marker = glyph ? `${glyph} ` : "";
			if (name === undefined) return marker + detail;
			const painted = theme.style(name, { fg: nameColor, bold: true });
			return marker + painted + neutralDetail(detail);
		},
	};
}

/** Render plain semantic text while retaining the explicitly requested inline attributes. */
export function densityCardText(text: DensityCardText, role: "muted" | "text" = "text"): string {
	if (typeof text === "string") return theme.fg(role, text);
	return text
		.map((span) => {
			const value = theme.style(span.text, { fg: role, italic: span.italic, strikethrough: span.strikethrough });
			return span.link && getCapabilities().hyperlinks ? hyperlink(value, span.link) : value;
		})
		.join("");
}

/** Format a structured heading with the major separator before its first detail. */
export function densityCardHeading(
	kind: DensityCardKind,
	heading: DensityCardHeading,
	style: ReturnType<typeof densityCardStyle>,
): string {
	if (heading.description !== undefined) return style.description(heading.description);
	const palette: DensityCardPalette = cardRegistry[kind];
	const name = palette.identityIsName && heading.identity ? heading.identity : palette.name;
	const identity = !palette.identityIsName && heading.identity ? ` ${densityCardText(heading.identity)}` : "";
	const details =
		heading.details
			?.filter((detail) =>
				typeof detail === "string" ? detail.length > 0 : detail.some((span) => span.text.length > 0),
			)
			.map((detail) => densityCardText(detail))
			.join(theme.fg("text", " · ")) ?? "";
	return style.label(name) + identity + (details ? theme.fg("text", " • ") + details : "");
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
