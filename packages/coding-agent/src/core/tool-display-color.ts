import { type Color, indexedColor, parseColor } from "@earendil-works/pi-tui";

// Basic CSS colors, plus commonly used names for tool accents.
const namedColors = new Map([
	["black", "#000000"],
	["silver", "#c0c0c0"],
	["gray", "#808080"],
	["grey", "#808080"],
	["white", "#ffffff"],
	["maroon", "#800000"],
	["red", "#ff0000"],
	["purple", "#800080"],
	["fuchsia", "#ff00ff"],
	["magenta", "#ff00ff"],
	["green", "#008000"],
	["lime", "#00ff00"],
	["olive", "#808000"],
	["yellow", "#ffff00"],
	["navy", "#000080"],
	["blue", "#0000ff"],
	["teal", "#008080"],
	["aqua", "#00ffff"],
	["cyan", "#00ffff"],
	["orange", "#ffa500"],
	["pink", "#ffc0cb"],
	["violet", "#ee82ee"],
	["lavender", "#e6e6fa"],
	["rebeccapurple", "#663399"],
]);

/** Accept configured names, RGB hex, or integer ANSI palette indices. */
export function parseToolDisplayColor(value: unknown): Color | undefined {
	const input = typeof value === "string" ? value.trim().toLowerCase() : value;
	const index = typeof input === "string" && /^\d+$/.test(input) ? Number(input) : input;
	if (typeof index === "number") {
		return Number.isInteger(index) && index >= 0 && index <= 255 ? indexedColor(index) : undefined;
	}
	if (typeof input !== "string") return undefined;
	const hex = namedColors.get(input) ?? input;
	return /^#(?:[\da-f]{3}|[\da-f]{6})$/.test(hex) ? parseColor(hex) : undefined;
}
