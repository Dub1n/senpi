import {
	applyBackgroundToLine,
	claimFrameRow,
	copyLineSources,
	dispatchMouseEvent,
	getLineSources,
	isImageLine,
	nextRenderRevision,
	renderAtFrameRow,
	setLineSources,
	stripTerminalSequences,
	type Component,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { toolDensitySummary } from "./tool-density-summary.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const paintGroup = (text: string) => theme.bg("toolSuccessBg", text);

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
	private readonly card: ToolExecutionComponent;
	private readonly requestRender: () => void;
	private grouped = false;
	private first = true;
	private last = true;
	private revision = 0;
	private detailLayout:
		| {
				readonly original: readonly string[];
				readonly start: number;
				readonly height: number;
				readonly inset: number;
		  }
		| undefined;

	constructor(card: ToolExecutionComponent, requestRender: () => void) {
		this.card = card;
		this.requestRender = requestRender;
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
		const state = this.card.summarySnapshot;
		const frameRow = claimFrameRow(this);
		if (state.expanded) return this.renderExpanded(width, frameRow);
		this.detailLayout = undefined;
		const summary = toolDensitySummary(state);
		const live =
			state.pending || summary.status === "running" || summary.status === "queued" || summary.status === "detached";
		const failed = summary.status === "failed" || summary.status === "cancelled";
		const paint = this.grouped ? paintGroup : this.card.getBackgroundPainter();
		const color = failed ? "error" : live ? "warning" : "success";
		const glyph = theme.fg(color, failed ? "✗" : live ? "○" : "✓");
		const left = width >= 3 ? " " : "";
		const right = width >= 4 ? "  " : left;
		const innerWidth = width - left.length - right.length;
		const marker = innerWidth < 5 ? glyph : `${theme.fg("muted", "╶─")} ${glyph} `;
		const available = Math.max(0, innerWidth - visibleWidth(marker));
		const title = theme.fg("toolTitle", summary.tool);
		const status = ` · ${theme.fg(color, summary.status)}`;
		const titleWidth = visibleWidth(title);
		const statusWidth = visibleWidth(status);
		// Keep the tool and status useful when the model gives a long description.
		const showStatus = !summary.attention && titleWidth + statusWidth + (summary.summary ? 16 : 0) <= available;
		const detailWidth = available - titleWidth - (showStatus ? statusWidth : 0) - 3;
		const description =
			summary.summary && detailWidth > 1 ? `${truncateToWidth(summary.summary, detailWidth, "…")} · ` : "";
		const attention = summary.attention;
		const countSuffix = summary.summary ? ` · ${summary.summary}` : "";
		const line = attention
			? `${theme.fg(color, attention)} · ${title}${
					visibleWidth(attention) + 3 + titleWidth + visibleWidth(countSuffix) <= available ? countSuffix : ""
				}`
			: `${description}${title}${showStatus ? status : ""}`;
		const header = applyBackgroundToLine(
			left + truncateToWidth(marker, innerWidth, "") + truncateToWidth(line, available, "…") + right,
			width,
			paint,
		);
		const blank = applyBackgroundToLine("", width, paint);
		return [...(this.first ? ["", blank] : []), header, ...(this.last ? [blank] : [])];
	}

	private renderExpanded(width: number, frameRow: number | undefined): string[] {
		let original = renderAtFrameRow(this.card, width, frameRow);
		let { start, end } = contentBounds(original);
		const inset =
			width >= 8 && start < end && !stripTerminalSequences(original[start]).trimStart().startsWith("╭─") ? 3 : 0;
		if (inset) {
			// Reserve frame columns before wrapping so the original renderer retains its
			// text, image rows and mouse targets at narrow terminal widths.
			original = renderAtFrameRow(this.card, width - inset, frameRow);
			({ start, end } = contentBounds(original));
		}
		this.detailLayout = { original, start, height: end - start, inset };
		const sources = getLineSources(original);
		const paint = this.grouped ? paintGroup : this.card.getBackgroundPainter();
		const blank = applyBackgroundToLine("", width, paint);
		const rows = original.slice(start, end);
		if (sources) setLineSources(rows, sources.slice(start, end));
		const body = rows.map((line, index) => {
			if (isImageLine(line)) return line;
			const border =
				inset === 0 ? "" : index === 0 ? ` ${theme.fg("borderAccent", "╭─")}` : ` ${theme.fg("borderMuted", "│")} `;
			return applyBackgroundToLine(border + line, width, paint, this.grouped ? "replace" : "fill");
		});
		if (inset) body.push(applyBackgroundToLine(` ${theme.fg("borderMuted", "╰─")}`, width, paint));
		const lines = [...(this.first ? ["", blank] : []), ...body, ...(this.last ? [blank] : [])];
		if (this.first) setLineSources(lines, [null, null]);
		if (this.last || inset) {
			const mapping = [...(getLineSources(lines) ?? [])];
			if (this.last) mapping[lines.length - 1] = null;
			if (inset) mapping[lines.length - (this.last ? 2 : 1)] = null;
			setLineSources(lines, mapping);
		}
		return copyLineSources(rows, lines, this.first ? 2 : 0, inset);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | TuiMouseDispatchResult | undefined {
		const state = this.card.summarySnapshot;
		const detail = this.detailLayout;
		if (state.expanded && detail) {
			const row = event.y - (this.first ? 2 : 0);
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
							width: event.width - detail.inset,
							height: detail.original.length,
						});
			if (result) return result;
			if (detail.original[y] === "" || getLineSources(detail.original)?.[y] === null) return undefined;
		} else if (event.y !== (this.first ? 2 : 0)) {
			return undefined;
		}
		// The alternate screen derives a click after a stationary release. Leaving
		// the initial press to it lets a drag select text from the same row.
		if (event.type !== "click" || event.button !== "left" || state.pending) return undefined;
		this.card.setExpanded(!state.expanded);
		this.requestRender();
		return { handled: true };
	}

	getRenderRevision(): number | undefined {
		const card = this.card.getRenderRevision();
		return card === undefined ? undefined : Math.max(card, this.revision);
	}

	invalidate(): void {
		this.detailLayout = undefined;
		this.card.invalidate();
	}
}
