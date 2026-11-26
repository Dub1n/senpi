// allow: SIZE_OK — One row couples frame layout with source maps and screen-to-content mouse coordinates.
import {
	applyBackgroundToLine,
	claimFrameRow,
	copyLineSources,
	dispatchMouseEvent,
	getLineSources,
	isImageLine,
	isSemanticDensityCardSource,
	nextRenderRevision,
	renderAtFrameRow,
	setLineSources,
	stripTerminalSequences,
	wrapTextWithAnsi,
	type Component,
	type DensityCardBlock,
	type DensityCardRenderOptions,
	type DensityCardStatus,
	type DensityCardStructuredView,
	type DensityCardView,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDisplayColors } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { densityCardHeading, densityCardStyle, densityCardText } from "./density-card-style.ts";
import type { DensityFold } from "./density-fold.ts";
import type { DensityMemberControls } from "./density-nest.ts";
import { toolDensityKind, toolDensitySummary } from "./tool-density-summary.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const paintGroup = (text: string) => theme.bg("toolSuccessBg", text);
const noBackground = (text: string) => text;
const defaultColors: ToolDisplayColors = { colorFrames: false, colorNames: false, colorIcons: false };
const livePreviewLines = 10;

/** A notice or assistant detail that participates in the tool-card layout. */
export interface DensityCardSource extends Component {
	readonly densityExpanded: boolean;
	readonly densityGroup?: boolean;
	readonly densityExpandable?: false;
	renderDensityCard?(width: number, options: DensityCardRenderOptions): DensityCardView | undefined;
	renderDensitySummary(width: number, grouped: boolean): string[];
	getBackgroundPainter(): ((text: string) => string) | undefined;
	setExpanded(expanded: boolean): void;
	setDensityDetail?(detail: boolean | undefined): void;
	toggleDensityMember?(index: number): void;
}

type ToolDensityRowOptions = {
	readonly fold?: DensityFold;
	readonly onToolOpen?: (card: ToolExecutionComponent) => void;
	readonly needsHandledPress?: () => boolean;
	readonly onPress?: (row: ToolDensityRow) => void;
	readonly isClickTarget?: (row: ToolDensityRow) => boolean;
};

export function isDensityCardSource(component: Component): component is DensityCardSource {
	return (
		"renderDensitySummary" in component &&
		typeof component.renderDensitySummary === "function" &&
		(!("noticeDensityEligible" in component) || component.noticeDensityEligible === true)
	);
}

function narrowLightning(line: string): string {
	return /^\s*\u26A1\uFE0F? Cache-warm\b/u.test(stripTerminalSequences(line))
		? line.replace(/\u26A1\uFE0F?/u, "↯")
		: line;
}

function contentBounds(lines: readonly string[]): { start: number; end: number } {
	const sources = getLineSources(lines);
	let start = lines[0] === "" ? 1 : 0;
	let end = lines.length;
	while (start < end && sources?.[start] === null) start++;
	while (end > start && sources?.[end - 1] === null) end--;
	return { start, end };
}

/** A non-owning summary with the original tool card as its click-to-expand detail. */
export class ToolDensityRow implements Component {
	private readonly card: ToolExecutionComponent | DensityCardSource;
	private readonly requestRender: () => void;
	private readonly getColors: () => ToolDisplayColors;
	private readonly options: ToolDensityRowOptions;
	private grouped = false;
	private first = true;
	private last = true;
	private revision = 0;
	private foldedHeight = 0;
	private expanded = false;
	private denseFold = false;
	private renderedDetail: boolean | undefined;
	private detailLayout:
		| {
				readonly original: readonly string[];
				readonly start: number;
				readonly height: number;
				readonly inset: number;
				readonly renderInset: number;
				readonly firstMember?: boolean;
				readonly sectionHeaders?: readonly {
					readonly start: number;
					readonly end: number;
					readonly member: number;
				}[];
		  }
		| undefined;

	constructor(
		card: ToolExecutionComponent | DensityCardSource,
		requestRender: () => void,
		getColors: () => ToolDisplayColors = () => defaultColors,
		options: ToolDensityRowOptions = {},
	) {
		this.card = card;
		this.requestRender = requestRender;
		this.options = options;
		this.getColors = getColors;
	}

	/** Put padding on the edges of the run without making the run one hydration unit. */
	setLayout(grouped: boolean, first: boolean, last: boolean): void {
		if (this.grouped === grouped && this.first === first && this.last === last) return;
		this.grouped = grouped;
		this.first = first;
		this.last = last;
		this.revision = nextRenderRevision();
	}

	render(width: number): string[] {
		const frameRow = claimFrameRow(this);
		const left = width >= 3 ? " " : "";
		const right = width >= 4 ? "  " : left;
		const innerWidth = width - left.length - right.length;
		const foldWidth = innerWidth >= 5 ? 3 : 0;
		const available = Math.max(0, innerWidth - foldWidth);
		const tool = "summarySnapshot" in this.card ? this.card : undefined;
		const densityCard = this.densityCard(available, false);
		const kind = densityCard?.kind ?? (tool ? (toolDensityKind(tool.summarySnapshot.name) ?? "tool") : undefined);
		const fold = this.options.fold;
		const fallback = "densityExpanded" in this.card ? this.card.densityExpanded : this.card.summarySnapshot.expanded;
		this.denseFold =
			kind !== undefined && fold !== undefined && !("densityGroup" in this.card && this.card.densityGroup);
		const namedDefault = this.denseFold && kind !== undefined ? fold?.defaultOpen(kind, fallback) : undefined;
		this.expanded =
			!("densityExpandable" in this.card && this.card.densityExpandable === false) &&
			(this.denseFold ? (fold?.choice ?? namedDefault ?? fallback) : fallback);
		const detail = tool || this.denseFold ? this.expanded : undefined;
		const detailChanged = detail !== this.renderedDetail;
		this.renderedDetail = detail;
		this.card.setDensityDetail?.(detail);
		if (this.expanded) return this.renderExpanded(width, frameRow);
		this.detailLayout = undefined;
		const foldedCard = detailChanged && densityCard !== undefined ? this.densityCard(available, false) : densityCard;
		const style = this.cardStyle(foldedCard?.kind);
		const gutterLabel = foldWidth ? `${style.frame("╶─")} ` : "";
		const summary =
			foldedCard !== undefined
				? [renderDensityCardSummary(foldedCard, style), ...(foldedCard.foldedDetails ?? [])]
				: "densityExpanded" in this.card
					? this.card.renderDensitySummary(available, this.grouped)
					: (this.card.renderNoticeDensitySummary(available) ?? [
							renderToolSummary(available, this.card.summarySnapshot, style),
						]);
		const paint = this.background;
		const blank = applyBackgroundToLine("", width, paint);
		const rows = summary.map((line, index) => {
			const gutter = index === 0 ? gutterLabel : " ".repeat(foldWidth);
			return applyBackgroundToLine(
				left + gutter + truncateToWidth(narrowLightning(line), available, "…") + right,
				width,
				paint,
				this.grouped ? "replace" : "fill",
			);
		});
		this.foldedHeight = rows.length;
		return [...(this.first ? ["", blank] : []), ...rows, ...(this.last ? [blank] : [])];
	}

	private densityCard(width: number, expanded = this.expanded): DensityCardView | undefined {
		if ("summarySnapshot" in this.card && this.card.summarySnapshot.hasVisibleImages) return undefined;
		return isSemanticDensityCardSource(this.card)
			? this.card.renderDensityCard(width, { grouped: this.grouped, expanded })
			: undefined;
	}

	private get background(): (text: string) => string {
		return this.grouped ? paintGroup : (this.card.getBackgroundPainter() ?? noBackground);
	}

	private cardStyle(kind?: DensityCardView["kind"]) {
		const toolName = "summarySnapshot" in this.card ? this.card.summarySnapshot.name : undefined;
		const cardKind = kind ?? (toolName === undefined ? undefined : toolDensityKind(toolName));
		const accentKind = cardKind === "tool" && toolName === "apply_patch" ? "patched" : cardKind;
		return densityCardStyle(this.getColors(), cardKind, accentKind);
	}

	private renderExpanded(width: number, frameRow: number | undefined): string[] {
		let densityCard = this.densityCard(width);
		if (densityCard !== undefined) return this.renderDensityCard(width, densityCard);
		let original = renderAtFrameRow(this.card, width, frameRow);
		densityCard = this.densityCard(width);
		if (densityCard !== undefined) return this.renderDensityCard(width, densityCard);
		let { start, end } = contentBounds(original);
		const renderInset =
			width >= 8 && start < end && !stripTerminalSequences(original[start]).trimStart().startsWith("╭─") ? 3 : 0;
		if (renderInset) {
			// Reserve frame columns before wrapping so the original renderer retains its
			// text, image rows and mouse targets at narrow terminal widths.
			original = renderAtFrameRow(this.card, width - renderInset, frameRow);
			({ start, end } = contentBounds(original));
		}
		const sourceInset = "summarySnapshot" in this.card ? this.card.summarySnapshot.contentInset : 0;
		const inset = renderInset === 0 ? 0 : 2 + Math.max(0, 1 - sourceInset);
		this.detailLayout = { original, start, height: end - start, inset, renderInset };
		const sources = getLineSources(original);
		const style = this.cardStyle();
		const paint = this.background;
		const blank = applyBackgroundToLine("", width, paint);
		const rows = original.slice(start, end);
		if (sources) setLineSources(rows, sources.slice(start, end));
		const body = rows.map((line, index) => {
			// Only the host's gutter is ours to paint. The renderer owns its heading,
			// body, pre-framed output, and terminal image protocols.
			if (isImageLine(line)) return line;
			const border =
				renderInset === 0
					? ""
					: index === 0
						? ` ${style.frame("╭─")}`
						: ` ${style.frame("│")}${" ".repeat(Math.max(0, 1 - sourceInset))}`;
			return applyBackgroundToLine(border + narrowLightning(line), width, paint, this.grouped ? "replace" : "fill");
		});
		if (renderInset) body.push(applyBackgroundToLine(` ${style.frame("╰─")}`, width, paint));
		const lines = [...(this.first ? ["", blank] : []), ...body, ...(this.last ? [blank] : [])];
		if (this.first) setLineSources(lines, [null, null]);
		if (this.last || renderInset) {
			const mapping = [...(getLineSources(lines) ?? [])];
			if (this.last) mapping[lines.length - 1] = null;
			if (renderInset) mapping[lines.length - (this.last ? 2 : 1)] = null;
			setLineSources(lines, mapping);
		}
		return copyLineSources(rows, lines, this.first ? 2 : 0, inset);
	}

	private renderDensityCard(
		width: number,
		view: DensityCardView & { readonly memberControls?: DensityMemberControls },
	): string[] {
		const paint = this.background;
		const style = this.cardStyle(view.kind);
		const bodyPrefix = ` ${style.frame("│")} `;
		const renderLabel = (prefix: string, content: string): string[] => {
			const available = Math.max(1, width - visibleWidth(prefix));
			return wrapTextWithAnsi(content, available).map((line) =>
				applyBackgroundToLine(prefix + line, width, paint, this.grouped ? "replace" : "fill"),
			);
		};
		const title = truncateToWidth(renderDensityCardSummary(view, style, true), Math.max(0, width - 4), "…");
		const frame = renderLabel(` ${style.frame("╭─")} `, title);
		const sectionHeaders: { start: number; end: number; member: number }[] = [];
		const livePreview = "summarySnapshot" in this.card && this.card.summarySnapshot.pending;
		const appendContent = (prefix: string, content: readonly string[]): void => {
			const skipped = livePreview && !content.some(isImageLine) ? Math.max(0, content.length - livePreviewLines) : 0;
			if (skipped) frame.push(...renderLabel(prefix, theme.fg("muted", `… ${skipped} earlier lines`)));
			const offset = frame.length;
			frame.push(
				...content
					.slice(skipped)
					.map((line) =>
						isImageLine(line)
							? line
							: applyBackgroundToLine(prefix + line, width, paint, this.grouped ? "replace" : "fill"),
					),
			);
			const sources = getLineSources(content);
			if (sources) {
				const rows = content.slice(skipped);
				setLineSources(rows, sources.slice(skipped));
				copyLineSources(rows, frame, offset, visibleWidth(prefix));
			}
		};
		const contentWidth = Math.max(1, width - visibleWidth(bodyPrefix));
		const renderBlocks = (
			blocks: readonly DensityCardBlock[],
			available: number,
			bodyRole: "text" | "muted",
		): string[] => {
			const lines: string[] = [];
			for (const block of blocks) {
				const rendered =
					block.type === "rich"
						? block.render(available, this.grouped)
						: block.lines.flatMap((line) =>
								wrapTextWithAnsi(densityCardText(line, block.role ?? bodyRole), available),
							);
				const offset = lines.length;
				lines.push(...rendered);
				copyLineSources(rendered, lines, offset);
			}
			return lines;
		};
		if (view.format === "structured") {
			appendContent(bodyPrefix, renderBlocks(view.body, contentWidth, style.bodyRole));
		} else {
			if (view.renderMetadata !== undefined) appendContent(bodyPrefix, view.renderMetadata(contentWidth));
			else if (view.metadata !== undefined) frame.push(...renderLabel(bodyPrefix, view.metadata));
			appendContent(bodyPrefix, view.renderContent(contentWidth));
		}
		if (livePreview && "summarySnapshot" in this.card) {
			const progress = this.card.renderDensityProgress();
			if (progress) frame.push(...renderLabel(bodyPrefix, progress));
		}
		const after: string[] = [];
		if (view.format === "structured") {
			for (const [sectionIndex, section] of view.sections.entries()) {
				const heading = section.heading;
				const sectionStyle = "kind" in heading ? this.cardStyle(heading.kind) : style;
				if (section.placement === "after" || (section.placement === "grouped" && !this.grouped)) {
					const content = renderBlocks(section.body, width, sectionStyle.bodyRole);
					const offset = after.length;
					after.push(...content);
					copyLineSources(content, after, offset);
					continue;
				}
				const label =
					"label" in heading
						? (heading.role ?? style.sectionRole) === "title"
							? style.titleSection(heading.label)
							: style.sectionLabel(heading.label, heading.bold)
						: renderStructuredHeading(heading, sectionStyle);
				const headerStart = frame.length;
				const glyph = view.memberControls?.terminalFoldedSection === sectionIndex ? "╰─" : "├─";
				frame.push(...renderLabel(` ${style.frame(glyph)} `, label));
				const member = view.memberControls?.sections[sectionIndex];
				if (member !== undefined) sectionHeaders.push({ start: headerStart, end: frame.length, member });
				appendContent(bodyPrefix, renderBlocks(section.body, contentWidth, sectionStyle.bodyRole));
			}
		} else {
			for (const section of view.sections) {
				if (section.placement === "after" || (section.placement === "grouped" && !this.grouped)) {
					const content = section.render(width, this.grouped);
					const offset = after.length;
					after.push(...content);
					copyLineSources(content, after, offset);
					continue;
				}
				const label = style.title({ name: section.name, detail: section.label, glyph: section.statusGlyph });
				frame.push(...renderLabel(` ${style.frame("├─")} `, label));
				appendContent(bodyPrefix, section.render(contentWidth, this.grouped));
			}
		}
		if (view.memberControls?.terminalFoldedSection === undefined) {
			frame.push(...renderLabel(` ${style.frame("╰─")}`, ""));
		}
		const blank = applyBackgroundToLine("", width, paint);
		const rows = [
			...frame,
			...after.map((line) => applyBackgroundToLine(line, width, paint, this.grouped ? "replace" : "fill")),
		];
		copyLineSources(frame, rows);
		copyLineSources(after, rows, frame.length);
		this.detailLayout = {
			original: rows,
			start: 0,
			height: rows.length,
			inset: 0,
			renderInset: 0,
			firstMember: view.memberControls?.first,
			...(sectionHeaders.length > 0 ? { sectionHeaders } : {}),
		};
		const lines = [...(this.first ? ["", blank] : []), ...rows, ...(this.last ? [blank] : [])];
		copyLineSources(rows, lines, this.first ? 2 : 0);
		if (this.first || this.last) {
			const mapping = [...(getLineSources(lines) ?? Array.from({ length: lines.length }, () => undefined))];
			if (this.first) {
				mapping[0] = null;
				mapping[1] = null;
			}
			if (this.last) mapping[lines.length - 1] = null;
			setLineSources(lines, mapping);
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | TuiMouseDispatchResult | undefined {
		if (event.type === "press" && event.button === "left") this.options.onPress?.(this);
		// Fullscreen dispatches a stationary release at its current layout. A
		// streamed update may have put a different invocation under that cell.
		if (
			event.type === "click" &&
			event.button === "left" &&
			event.clickCount !== undefined &&
			this.options.isClickTarget?.(this) === false
		)
			return undefined;
		const expanded = this.expanded;
		const detail = this.detailLayout;
		let row: number;
		if (expanded && detail) {
			row = event.y - (this.first ? 2 : 0);
			if (row < 0 || row >= detail.height) return undefined;
			const y = detail.start + row;
			const x = event.x - detail.inset;
			const result =
				x < 0
					? undefined
					: dispatchMouseEvent(this.card, {
							...event,
							x,
							y,
							width: event.width - detail.renderInset,
							height: detail.original.length,
						});
			if (result) return result;
			if (detail.original[y] === "" || getLineSources(detail.original)?.[y] === null) return undefined;
		} else {
			row = event.y - (this.first ? 2 : 0);
			if (row < 0 || row >= this.foldedHeight) return undefined;
		}
		// The alternate screen derives a click after a stationary release. Leaving
		// the initial press to it lets a drag select text from the same row.
		if (event.button !== "left") return undefined;
		if ("densityExpandable" in this.card && this.card.densityExpandable === false) return undefined;
		if (
			event.type === "press" &&
			"summarySnapshot" in this.card &&
			this.card.summarySnapshot.pending &&
			this.options.needsHandledPress?.()
		)
			return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		if (
			"densityGroup" in this.card &&
			this.card.densityGroup === true &&
			"toggleDensityMember" in this.card &&
			this.card.toggleDensityMember
		) {
			if (row === 0 && (!expanded || event.x < 3)) {
				this.card.setExpanded(!expanded);
			} else if (expanded && detail?.firstMember && row === 0 && event.x >= 4) {
				this.card.toggleDensityMember(0);
			} else if (expanded && detail) {
				const target = detail.sectionHeaders?.find(({ start, end }) => row >= start && row < end);
				if (!target) return undefined;
				this.card.toggleDensityMember(target.member);
			} else {
				return undefined;
			}
			this.requestRender();
			return { handled: true };
		}
		if (this.denseFold && this.options.fold) {
			if ("summarySnapshot" in this.card) {
				this.options.fold.setToolChoice(!expanded, this.card.summarySnapshot.pending);
				if (!expanded) this.options.onToolOpen?.(this.card);
			} else {
				this.options.fold.set(!expanded);
			}
		} else {
			this.card.setExpanded(!expanded);
		}
		this.requestRender();
		return { handled: true };
	}

	getRenderRevision(): number | undefined {
		const card = this.card.getRenderRevision?.();
		return card === undefined ? undefined : Math.max(card, this.revision, this.options.fold?.revision ?? 0);
	}

	invalidate(): void {
		this.detailLayout = undefined;
		this.card.invalidate();
	}
}

function renderToolSummary(
	width: number,
	state: ToolExecutionComponent["summarySnapshot"],
	style: ReturnType<typeof densityCardStyle>,
): string {
	const summary = toolDensitySummary(state);
	const title = style.title({
		name: summary.name,
		detail: summary.name === undefined ? theme.fg("text", summary.detail) : summary.detail,
	});
	const marker = `${style.icon(rawDensityStatusGlyph(summary.status))} `;
	const label = densityStatusLabel(summary.status);
	const color =
		summary.status === "pending" || summary.status === "queued"
			? "muted"
			: summary.status === "cancelled" || summary.status === "failed"
				? "error"
				: "warning";
	const line = summary.attention
		? `${theme.fg("error", summary.attention)} · ${title}`
		: `${title}${label ? `${theme.fg("dim", " · ")}${theme.fg(color, label)}` : ""}`;
	return truncateToWidth(marker, width, "") + truncateToWidth(line, width - visibleWidth(marker), "…");
}

function renderDensityCardSummary(
	view: DensityCardView,
	style: ReturnType<typeof densityCardStyle>,
	expanded = false,
): string {
	if (view.format === "structured") {
		return renderStructuredHeading(
			{ ...view, heading: expanded ? (view.expandedHeading ?? view.heading) : view.heading },
			style,
		);
	}
	const title = style.title({
		name: view.name,
		detail: expanded ? (view.expandedTitle ?? view.title) : view.title,
		glyph: view.statusGlyph ?? rawDensityStatusGlyph(view.status),
	});
	const status = densityStatusLabel(view.status);
	return title + (status ? `${theme.fg("dim", " · ")}${theme.fg("muted", status)}` : "");
}

function renderStructuredHeading(
	view: Pick<DensityCardStructuredView, "kind" | "heading" | "statusGlyph" | "status">,
	style: ReturnType<typeof densityCardStyle>,
): string {
	const glyph = view.statusGlyph ?? rawDensityStatusGlyph(view.status);
	const title = densityCardHeading(view.kind, view.heading, style);
	const label = densityStatusLabel(view.status);
	const hasDetails = view.heading.details?.some((detail) =>
		typeof detail === "string" ? detail.length > 0 : detail.some((span) => span.text.length > 0),
	);
	const separator = view.heading.description !== undefined || hasDetails ? " · " : " • ";
	return (
		(glyph ? `${style.icon(glyph)} ` : "") +
		title +
		(label ? `${theme.fg("dim", separator)}${theme.fg("muted", label)}` : "")
	);
}

function rawDensityStatusGlyph(status: DensityCardStatus | undefined): string {
	switch (status) {
		case undefined:
			return "";
		case "pending":
		case "running":
		case "queued":
			return "○";
		case "detached":
			return "↗";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "×";
		default:
			return assertNever(status);
	}
}

function densityStatusLabel(status: DensityCardStatus | undefined): string {
	switch (status) {
		case undefined:
		case "running":
		case "done":
		case "failed":
			return "";
		case "pending":
		case "queued":
		case "detached":
		case "cancelled":
			return status;
		default:
			return assertNever(status);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unhandled density-card status: ${String(value)}`);
}
