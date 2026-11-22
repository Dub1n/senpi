import {
	Box,
	type Component,
	type DensityCardRenderOptions,
	type DensityCardSource,
	type DensityCardStructuredView,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { NoticeSpec } from "./spec.ts";

const BOLD = "[1m";
const BOLD_OFF = "[22m";

function noticeText(text: string): Component {
	return {
		render(width: number): string[] {
			return wrapTextWithAnsi(text, Math.max(1, width));
		},
		invalidate(): void {},
	};
}

/** Render a NoticeSpec as the shared transcript notice box (loop-guard visual family). */
export function buildNoticeBox(spec: NoticeSpec, options: { readonly expanded: boolean }, theme: Theme): Component {
	const box =
		spec.densityCard !== undefined
			? new DenseNoticeBox(spec, options, theme)
			: new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(noticeText(theme.fg(spec.tone ?? "accent", `${BOLD}${spec.title}${BOLD_OFF}`)));
	box.addChild(noticeText(theme.fg("dim", spec.why)));
	for (const line of spec.extra ?? []) {
		box.addChild(noticeText(theme.fg(line.tone ?? "dim", line.text)));
	}
	if (options.expanded && spec.expandedLine !== undefined) {
		box.addChild(noticeText(theme.fg("dim", spec.expandedLine)));
	}
	return box;
}

class DenseNoticeBox extends Box implements DensityCardSource {
	private readonly spec: NoticeSpec;
	private readonly expanded: boolean;

	constructor(spec: NoticeSpec, options: { readonly expanded: boolean }, theme: Theme) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.spec = spec;
		this.expanded = options.expanded;
	}

	renderDensityCard(_width: number, _options: DensityCardRenderOptions): DensityCardStructuredView | undefined {
		const densityCard = this.spec.densityCard;
		if (!densityCard) return undefined;
		const lines = [this.spec.why, ...(this.spec.extra ?? []).map((line) => line.text)];
		if (this.expanded && this.spec.expandedLine !== undefined) lines.push(this.spec.expandedLine);
		return { ...densityCard, format: "structured", body: [{ type: "text", lines, role: "muted" }], sections: [] };
	}
}
