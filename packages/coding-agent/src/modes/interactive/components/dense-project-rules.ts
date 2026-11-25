import {
	type DensityCardRenderOptions,
	type DensityCardStructuredView,
	getGraphemeSegmenter,
	nextRenderRevision,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ProjectRulesActivationDetails } from "../../../core/extensions/builtin/rule-activation/types.ts";
import type { CustomEntryComponent } from "./custom-entry.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

function displayRecordedPath(path: string): string {
	// Preserve significant filename spaces while keeping paths on one logical line.
	return stripTerminalSequences(path).replace(/\p{Cc}+/gu, " ");
}

/** Pre-wrap path lines by cell width, since prose wrapping discards spaces at breaks. */
function wrapRecordedPathLine(text: string, width: number): string[] {
	const available = Math.max(1, width);
	if (visibleWidth(text) <= available) return [text];
	const lines: string[] = [];
	let start = 0;
	let used = 0;
	for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
		const cells = visibleWidth(segment);
		if (used > 0 && used + cells > available) {
			lines.push(text.slice(start, index));
			start = index;
			used = 0;
		}
		used += cells;
	}
	lines.push(text.slice(start));
	return lines;
}

/** Render the recorded rule labels and targets without inferring per-rule match data. */
export function projectRulesDensityCard(
	notices: readonly ProjectRulesActivationDetails[],
	width: number,
	expanded: boolean,
): DensityCardStructuredView {
	const matches = notices.flatMap(({ rules, targetPath }) => {
		const target = displayRecordedPath(targetPath);
		return rules.map((rule) => ({ rule: displayRecordedPath(rule), target }));
	});
	const labels = matches.map(({ rule }) => rule).join(" ");
	const count = matches.length;
	const noun = count === 1 ? "rule" : "rules";
	const titleWidth = expanded ? width - 4 : width;
	const labelsFit = visibleWidth(`● project rules • ${labels}`) <= titleWidth;
	const detail = labelsFit ? labels : `${count} ${noun} matched`;
	const single = count === 1 && labelsFit ? matches[0] : undefined;
	const matchedOn = (target: string) => wrapRecordedPathLine(`matched on: ${target}`, width - 3);
	const summary =
		notices.length === 1
			? [`${count} ${count === 1 ? "instruction" : "instructions"} matched and injected for this tool result.`]
			: [];
	return {
		format: "structured",
		kind: "project-rules",
		heading: { details: [detail] },
		statusGlyph: "●",
		body: expanded ? [{ type: "text", lines: [...summary, ...(single ? matchedOn(single.target) : [])] }] : [],
		sections:
			expanded && !single
				? matches.map(({ rule, target }) => ({
						placement: "frame",
						heading: { label: wrapRecordedPathLine(`rule • ${rule}`, titleWidth).join("\n") },
						body: [{ type: "text", lines: matchedOn(target) }],
					}))
				: [],
	};
}

export interface DenseProjectRulesMember {
	readonly card: CustomEntryComponent;
	readonly notice: ProjectRulesActivationDetails;
}

/** Non-owning view of adjacent notices; keep click expansion on the original entries. */
export class DenseProjectRulesRun implements DensityCardSource {
	private members: readonly DenseProjectRulesMember[] = [];
	private revision = nextRenderRevision();

	setMembers(members: readonly DenseProjectRulesMember[]): void {
		if (
			this.members.length === members.length &&
			this.members.every(
				({ card, notice }, index) => card === members[index].card && notice === members[index].notice,
			)
		)
			return;
		this.members = members;
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		return this.members.some(({ card }) => card.densityExpanded);
	}

	setExpanded(expanded: boolean): void {
		for (const { card } of this.members) card.setExpanded(expanded);
	}

	renderDensityCard(width: number, { expanded = false }: DensityCardRenderOptions): DensityCardStructuredView {
		return projectRulesDensityCard(
			this.members.map(({ notice }) => notice),
			width,
			expanded,
		);
	}

	renderDensitySummary(width: number, grouped: boolean): string[] {
		return this.members[0].card.renderDensitySummary(width, grouped);
	}

	render(width: number): string[] {
		return this.renderDensitySummary(width, false);
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		return this.members[0].card.getBackgroundPainter();
	}

	getRenderRevision(): number | undefined {
		let revision = this.revision;
		for (const { card } of this.members) {
			const member = card.getRenderRevision();
			if (member === undefined) return undefined;
			revision = Math.max(revision, member);
		}
		return revision;
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}
}
