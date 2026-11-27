import {
	type DensityCardRenderOptions,
	type DensityCardStructuredView,
	type DensityCardStructuredSection,
	nextRenderRevision,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ProjectRulesActivationDetails } from "../../../core/extensions/builtin/rule-activation/types.ts";
import type { CustomEntryComponent } from "./custom-entry.ts";
import type { DensityFold } from "./density-fold.ts";
import { DensityRunFold } from "./density-nest.ts";
import { projectRulesDensityMembers } from "./project-rules-density-projection.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

/** Render the recorded rule labels and targets without inferring per-rule match data. */
export function projectRulesDensityCard(
	notices: readonly ProjectRulesActivationDetails[],
	width: number,
	expanded: boolean,
	member = false,
): DensityCardStructuredView {
	const matches = projectRulesDensityMembers(notices, width);
	const labels = matches.map(({ rule }) => rule).join(" ");
	const count = matches.length;
	const noun = count === 1 ? "rule" : "rules";
	const titleWidth = expanded ? width - 4 : width;
	const labelsFit = visibleWidth(`● project rules • ${labels}`) <= titleWidth;
	const detail = labelsFit ? labels : `${count} ${noun} matched`;
	const single = count === 1 && labelsFit && !member ? matches[0] : undefined;
	const summary =
		notices.length === 1 && !member
			? [`${count} ${count === 1 ? "instruction" : "instructions"} matched and injected for this tool result.`]
			: [];
	return {
		format: "structured",
		kind: "project-rules",
		heading: { details: [detail] },
		statusGlyph: "●",
		body:
			expanded && !member
				? [
						{
							type: "text",
							lines: [
								...summary,
								...(single?.view.body.flatMap((block) => (block.type === "text" ? block.lines : [])) ?? []),
							],
						},
					]
				: [],
		sections:
			expanded && !single
				? matches.map(({ label, view }) => ({
						placement: "frame",
						heading: { label },
						body: view.body,
					}))
				: [],
	};
}

export interface DenseProjectRulesMember {
	readonly card: CustomEntryComponent;
	readonly notice: ProjectRulesActivationDetails;
	readonly ruleFolds: readonly DensityFold[];
}

/** Non-owning view of adjacent notices; keep click expansion on the original entries. */
export class DenseProjectRulesRun implements DensityCardSource {
	readonly densityGroup = true;
	private readonly folds: DensityRunFold;
	private members: readonly DenseProjectRulesMember[] = [];
	private ruleFoldsInView: readonly DensityFold[] = [];
	private revision = nextRenderRevision();

	constructor(parent: DensityFold) {
		this.folds = new DensityRunFold(parent);
	}

	setMembers(members: readonly DenseProjectRulesMember[], folds: readonly DensityFold[]): void {
		if (
			this.members.length === members.length &&
			this.members.every(
				({ card, notice, ruleFolds }, index) =>
					card === members[index].card &&
					notice === members[index].notice &&
					ruleFolds.length === members[index].ruleFolds.length &&
					ruleFolds.every((fold, ruleIndex) => fold === members[index].ruleFolds[ruleIndex]),
			)
		)
			return;
		this.members = members;
		this.folds.join(folds);
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		if (this.members.length === 1) return this.members[0].card.densityExpanded;
		return this.folds.open(
			"project-rules",
			this.members.some(({ card }) => card.densityExpanded),
		);
	}

	setExpanded(expanded: boolean): void {
		if (this.members.length === 1) {
			this.members[0].card.setExpanded(expanded);
			return;
		}
		this.folds.set(expanded);
	}

	toggleDensityMember(index: number): void {
		if (index < this.members.length) {
			if (this.members.length === 1) {
				this.members[0].card.setExpanded(!this.members[0].card.densityExpanded);
				return;
			}
			this.folds.toggleMember(index, "project-rules");
			return;
		}
		const fold = this.ruleFoldsInView[index - this.members.length];
		if (fold) fold.set(!this.ruleOpen(fold));
	}

	renderDensityCard(width: number, { expanded = false }: DensityCardRenderOptions) {
		if (!expanded) {
			this.ruleFoldsInView = [];
			return projectRulesDensityCard(
				this.members.map(({ notice }) => notice),
				width,
				false,
			);
		}
		const [first, ...rest] = this.members;
		if (!first) return projectRulesDensityCard([], width, false);
		const firstSummary = projectRulesDensityCard(
			[first.notice],
			width,
			this.members.length === 1,
			this.members.length > 1,
		);
		const firstOpen =
			this.members.length === 1 ? first.card.densityExpanded : this.folds.memberOpen(0, "project-rules");
		const sections: DensityCardStructuredSection[] = [];
		const sectionControls: (number | undefined)[] = [];
		const ruleFoldsInView: DensityFold[] = [];
		const appendRuleMembers = (noticeIndex: number): void => {
			const member = this.members[noticeIndex];
			if (!member) return;
			for (const [ruleIndex, rule] of projectRulesDensityMembers([member.notice], width).entries()) {
				const fold = member.ruleFolds[ruleIndex];
				const open = fold ? this.ruleOpen(fold) : true;
				if (fold) ruleFoldsInView.push(fold);
				sectionControls.push(fold ? this.members.length + ruleFoldsInView.length - 1 : undefined);
				sections.push({
					placement: "frame",
					heading: { label: rule.label },
					body: open ? rule.view.body : [],
				});
			}
		};
		if (firstOpen) appendRuleMembers(0);
		let terminalFoldedSection: number | undefined;
		for (const [offset, member] of rest.entries()) {
			const index = offset + 1;
			const hasRules = member.notice.rules.length > 0;
			const open = hasRules && this.folds.memberOpen(index, "project-rules");
			if (hasRules && index === this.members.length - 1 && !open) terminalFoldedSection = sections.length;
			const noticeCard = projectRulesDensityCard([member.notice], width, true, true);
			sectionControls.push(hasRules ? index : undefined);
			sections.push({
				placement: "frame",
				heading: { kind: "project-rules", heading: noticeCard.heading, statusGlyph: "●" },
				body: [],
			});
			if (open) appendRuleMembers(index);
		}
		this.ruleFoldsInView = ruleFoldsInView;
		return {
			...firstSummary,
			heading: firstSummary.heading,
			body: firstOpen ? firstSummary.body : [],
			sections,
			memberControls: {
				first: first.notice.rules.length > 0,
				sections: sectionControls,
				...(terminalFoldedSection === undefined ? {} : { terminalFoldedSection }),
			},
		};
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
		let revision = Math.max(this.revision, this.folds.revision);
		for (const { card } of this.members) {
			const member = card.getRenderRevision();
			if (member === undefined) return undefined;
			revision = Math.max(revision, member);
		}
		for (const fold of this.members.flatMap(({ ruleFolds }) => ruleFolds))
			revision = Math.max(revision, fold.revision);
		return revision;
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}

	private ruleOpen(fold: DensityFold): boolean {
		return fold.memberChoice ?? fold.defaultOpen("project-rules", true, true);
	}
}
