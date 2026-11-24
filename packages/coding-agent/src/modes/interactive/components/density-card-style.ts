import {
	type Color,
	type DensityCardHeading,
	type DensityCardKind,
	type DensityCardText,
	extractAnsiCode,
	getCapabilities,
	hyperlink,
	parseColor,
	stripTerminalSequences,
	styleText,
} from "@earendil-works/pi-tui";
import type { ToolDisplayColors } from "../../../core/settings-manager.ts";
import { theme, type ThemeColor } from "../theme/theme.ts";

type CardAccent = ThemeColor | Readonly<Record<"dark" | "light", Color>>;

type DensityCardPalette = {
	readonly name: string;
	readonly accent: CardAccent;
	readonly frame: "accent" | "muted";
	readonly body: "text" | "muted";
	readonly section: "title" | "muted";
	readonly identityPlacement?: "name" | "detail";
};

const memoryAccent = "customMessageLabel";
const bashAccent = "syntaxFunction";
const todoAccent = { dark: parseColor("#f48fb1"), light: parseColor("#a32959") };
const agentAccent = { dark: parseColor("#c4b5fd"), light: parseColor("#7856b4") };

const cardRegistry = {
	eval: {
		name: "eval",
		accent: "syntaxType",
		frame: "muted",
		body: "muted",
		section: "muted",
		identityPlacement: "name",
	},
	shell: { name: "bash", accent: bashAccent, frame: "accent", body: "text", section: "muted" },
	powershell: { name: "powershell", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	"bash-output": { name: "bash", accent: bashAccent, frame: "accent", body: "muted", section: "muted" },
	"loop-guard": { name: "Loop guard", accent: bashAccent, frame: "accent", body: "muted", section: "muted" },
	wait: { name: "wait", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	wake: { name: "wake", accent: "syntaxFunction", frame: "accent", body: "text", section: "muted" },
	read: { name: "read", accent: "syntaxVariable", frame: "accent", body: "muted", section: "muted" },
	todo: { name: "todo", accent: todoAccent, frame: "accent", body: "text", section: "muted" },
	goal: { name: "goal", accent: "mdHeading", frame: "accent", body: "text", section: "muted" },
	edit: { name: "edit", accent: "mdLink", frame: "accent", body: "muted", section: "muted" },
	write: { name: "write", accent: "mdLink", frame: "accent", body: "muted", section: "muted" },
	added: {
		name: "added",
		accent: "success",
		frame: "accent",
		body: "muted",
		section: "muted",
		identityPlacement: "detail",
	},
	edited: {
		name: "edited",
		accent: "mdLink",
		frame: "accent",
		body: "muted",
		section: "muted",
		identityPlacement: "detail",
	},
	deleted: {
		name: "deleted",
		accent: "error",
		frame: "accent",
		body: "muted",
		section: "muted",
		identityPlacement: "detail",
	},
	patched: {
		name: "patched",
		accent: "syntaxString",
		frame: "accent",
		body: "muted",
		section: "muted",
		identityPlacement: "detail",
	},
	memory: { name: "remembered", accent: memoryAccent, frame: "accent", body: "text", section: "muted" },
	skill: { name: "skill", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	rules: { name: "rules", accent: "customMessageLabel", frame: "accent", body: "text", section: "muted" },
	"project-rules": {
		name: "project rules",
		accent: "customMessageLabel",
		frame: "accent",
		body: "text",
		section: "muted",
	},
	kibitz: { name: "kibitz", accent: agentAccent, frame: "accent", body: "text", section: "muted" },
	message: { name: "message", accent: agentAccent, frame: "accent", body: "text", section: "muted" },
	"incoming-message": { name: "from", accent: agentAccent, frame: "accent", body: "text", section: "muted" },
	"outgoing-message": {
		name: "messaged",
		accent: agentAccent,
		frame: "accent",
		body: "text",
		section: "muted",
	},
	task: { name: "task", accent: agentAccent, frame: "accent", body: "text", section: "muted" },
	"task-peek": { name: "peek", accent: agentAccent, frame: "accent", body: "text", section: "muted" },
	tool: { name: "tool", accent: "syntaxVariable", frame: "accent", body: "text", section: "muted" },
	search: { name: "search", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	find: { name: "find", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	grep: { name: "grep", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	ls: { name: "ls", accent: "mdLink", frame: "accent", body: "text", section: "muted" },
	compaction: { name: "compacted", accent: memoryAccent, frame: "accent", body: "text", section: "muted" },
	system: { name: "system", accent: "muted", frame: "accent", body: "text", section: "muted" },
} as const satisfies Readonly<Record<DensityCardKind, DensityCardPalette>>;

function cardColorKind(kind: DensityCardKind): DensityCardKind {
	// A write can create or update a file; use the edit accent until the result establishes which.
	return kind === "edit" || kind === "write" ? "edited" : kind;
}

function cardColorName(kind: DensityCardKind): string {
	// Both variants say "bash"; keep their independently configurable accents.
	return kind === "bash-output" ? "bash (output)" : cardRegistry[cardColorKind(kind)].name;
}

export const densityCardColorNames: readonly string[] = [
	...new Set((Object.keys(cardRegistry) as DensityCardKind[]).map(cardColorName)),
].sort((a, b) => a.localeCompare(b));

type DensityTitle = {
	readonly name?: string | undefined;
	readonly detail: string;
	readonly glyph?: string | undefined;
};

/** Paint dense card chrome without inheriting any color from status or body text. */
export function densityCardStyle(colors: ToolDisplayColors, kind?: DensityCardKind, accentKind = kind) {
	const palette: DensityCardPalette | undefined = kind === undefined ? undefined : cardRegistry[kind];
	const chrome = accentKind === undefined ? undefined : cardRegistry[cardColorKind(accentKind)];
	const configured = accentKind === undefined ? undefined : colors.overrides?.get(cardColorName(accentKind));
	const accent = chrome?.accent;
	const defaultColor = typeof accent === "object" ? accent[theme.appearance] : accent;
	const nameColor = colors.colorNames ? (configured ?? defaultColor ?? "toolTitle") : "toolTitle";
	const frameColor = configured ?? (chrome?.frame === "accent" ? (defaultColor ?? "borderMuted") : "borderMuted");
	const paint = (text: string, fg: ThemeColor | Color, bold = false) =>
		typeof fg === "string" ? theme.style(text, { fg, bold }) : styleText(text, { fg, bold }, theme.getColorMode());
	// Compatibility producers may still pass ANSI. A renderer cannot override the glyph policy.
	const icon = (glyph: string) => paint(stripTerminalSequences(glyph), colors.colorIcons ? frameColor : "text");
	return {
		frame: (gutter: string) => paint(gutter, colors.colorFrames ? frameColor : "borderMuted"),
		icon,
		label: (label: string) => paint(label, nameColor, true),
		description: (label: string) => theme.fg("toolTitle", label),
		titleSection: (label: string) => paint(label, nameColor, true),
		bodyRole: palette?.body ?? "text",
		sectionRole: palette?.section ?? "muted",
		title: ({ name, detail, glyph }: DensityTitle) => {
			const marker = glyph ? `${icon(glyph)} ` : "";
			if (name === undefined) return marker + detail;
			const painted = paint(name, nameColor, true);
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
	const name = palette.identityPlacement === "name" && heading.identity ? heading.identity : palette.name;
	const identitySuffix = heading.identitySuffix === undefined ? "" : densityCardText(heading.identitySuffix);
	const identity = heading.identity ? densityCardText(heading.identity) + identitySuffix : "";
	const details =
		heading.details
			?.filter((detail) =>
				typeof detail === "string" ? detail.length > 0 : detail.some((span) => span.text.length > 0),
			)
			.map((detail) => densityCardText(detail)) ?? [];
	if (palette.identityPlacement === "detail" && identity) details.unshift(identity);
	const nameSuffix = palette.identityPlacement === "name" && heading.identity ? identitySuffix : "";
	const inlineIdentity = palette.identityPlacement === undefined && identity ? ` ${identity}` : "";
	const separatedDetails = details.length > 0 ? theme.fg("text", " • ") + details.join(theme.fg("text", " · ")) : "";
	return style.label(name) + nameSuffix + inlineIdentity + separatedDetails;
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
