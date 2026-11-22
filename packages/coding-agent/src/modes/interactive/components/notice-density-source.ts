import {
	Box,
	type Component,
	type DensityCardView,
	joinLineArrays,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Returns the first styled title line from a recognized purple notice box. */
export function renderNoticeBoxTitle(component: Component | undefined, width: number): string[] | undefined {
	const box = noticeBox(component);
	if (!box) return undefined;
	const firstLine = box.children[0]
		?.render(Math.max(width + 1, 4096))
		.find((line) => stripTerminalSequences(line).trim().length > 0);
	if (firstLine === undefined) return undefined;
	// Text pads its rendered lines to the probe width; only the title counts toward truncation.
	return [truncateToWidth(firstLine, visibleWidth(stripTerminalSequences(firstLine).trimEnd()), "")];
}

/** Returns the notice box painter when the component uses the shared purple notice background. */
export function noticeBoxBackground(component: Component | undefined): ((text: string) => string) | undefined {
	return noticeBox(component)?.getBackgroundPainter();
}

/** Returns whether a component is a purple box with one of the shared notice title forms. */
export function isNoticeBox(component: Component | undefined): boolean {
	return noticeBox(component) !== undefined;
}

/** Returns whether a rendered box is a known notice rather than an arbitrary purple extension box. */
export function isRememberedNoticeBox(component: Component | undefined): boolean {
	const box = purpleBox(component);
	return box !== undefined && hasTitle(box, (title) => /^(?:●\s*)?Remembered(?:$|\s|·)/u.test(title));
}

/** Adapt the title slot of a known local or pinned OmO notice; keep its child rows intact. */
export function renderNamedNoticeCard(
	component: Component | undefined,
	kind: "memory" | "rules" | "kibitz",
): DensityCardView | undefined {
	const box = purpleBox(component);
	if (!box) return undefined;
	const title = stripTerminalSequences(box.children[0]?.render(4096)[0] ?? "").trim();
	const match = /^(?:(●|⚠|⚡|✦|↯)\s+)?(.*)$/u.exec(title);
	if (!match) return undefined;
	const [, glyph, text] = match;
	const prefix = kind === "memory" ? "Remembered" : kind === "rules" ? "Project rules" : "Kibitzer";
	if (!(text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix} ·`))) return undefined;
	return {
		name: kind === "kibitz" ? "kibitz" : prefix.toLowerCase(),
		kind,
		title: text.slice(prefix.length),
		...(glyph ? { statusGlyph: glyph } : {}),
		renderContent: (width) => joinLineArrays(box.children.slice(1).map((child) => child.render(width))),
		sections: [],
	};
}

/** These custom types are the identities used by the rule and pinned OmO notice producers. */
export function namedNoticeKind(customType: string): "rules" | "kibitz" | undefined {
	switch (customType) {
		case "rule-activation":
			return "rules";
		case "omo-kibitzer:nudged":
		case "omo-kibitzer:gate":
		case "omo-kibitzer:unavailable":
			return "kibitz";
		default:
			return undefined;
	}
}

function noticeBox(component: Component | undefined): Box | undefined {
	const box = purpleBox(component);
	return box !== undefined && hasTitle(box, isNoticeTitle) ? box : undefined;
}

function purpleBox(component: Component | undefined): Box | undefined {
	if (!(component instanceof Box)) return undefined;
	const painter = component.getBackgroundPainter();
	return painter?.("notice-density-probe") === theme.bg("customMessageBg", "notice-density-probe")
		? component
		: undefined;
}

function hasTitle(box: Box, matches: (title: string) => boolean): boolean {
	const title = box.children[0]?.render(128)[0];
	return title !== undefined && matches(stripTerminalSequences(title).trimStart());
}

function isNoticeTitle(title: string): boolean {
	return (
		/^(?:●|⚠|⚡|✦)\s/u.test(title) ||
		/^(?:Cache[\s-]?warm\b|Project rules\b|Stream rule\b|Remembered notice\b|Aha moment\b|Loop guard\b)/u.test(title)
	);
}
