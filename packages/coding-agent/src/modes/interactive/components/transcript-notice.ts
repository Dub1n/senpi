import { Container, type DensityCardLegacyView, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildNoticeBox, type NoticeSpec } from "../../../core/extensions/notice/index.ts";
import { theme } from "../theme/theme.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

/** A built-in notice mounted in the transcript rather than in a widget or the header. */
export class TranscriptNotice extends Container implements DensityCardSource {
	private readonly spec: NoticeSpec;
	readonly highReasoningModel: string | undefined;
	private expanded: boolean;

	constructor(spec: NoticeSpec, expanded: boolean, highReasoningModel?: string) {
		super();
		this.spec = spec;
		this.highReasoningModel = highReasoningModel;
		this.expanded = expanded;
		this.rebuild();
	}

	get densityExpanded(): boolean {
		return this.expanded;
	}

	renderDensitySummary(): string[] {
		return [theme.fg(this.spec.tone ?? "accent", theme.bold(this.spec.title))];
	}

	renderDensityCard(): DensityCardLegacyView | undefined {
		if (this.highReasoningModel === undefined) return undefined;
		const tone = this.spec.tone ?? "accent";
		return {
			title:
				theme.fg(tone, theme.bold("HIGH-REASONING MODEL WARNING")) +
				theme.fg("dim", " • ") +
				theme.fg(tone, this.highReasoningModel),
			statusGlyph: "!",
			renderContent: (width) =>
				[theme.fg(tone, this.spec.why), ...(this.spec.extra ?? []).map(({ text }) => theme.fg(tone, text))].flatMap(
					(line) => wrapTextWithAnsi(line, width),
				),
			sections: [],
		};
	}

	getBackgroundPainter(): (text: string) => string {
		return (text) => theme.bg("customMessageBg", text);
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	override invalidate(): void {
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(buildNoticeBox(this.spec, { expanded: this.expanded }, theme));
	}
}
