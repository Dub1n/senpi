import {
	type DensityCardKind,
	type DensityCardText,
	nextRenderRevision,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import type { DensityFold } from "./density-fold.ts";
import { denseBashMemberSessionId, type DenseBashMember } from "./dense-bash-projection.ts";
import { densityNestView, DensityRunFold } from "./density-nest.ts";
import { displayBashSessionId, TerminalBackgroundNotice } from "./terminal-background-notice.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

function compactIds(ids: readonly string[], width: number): string {
	if (ids.length === 0 || width <= 0) return "";
	const full = ids.join(" ");
	if (visibleWidth(full) <= width) return full;
	for (let count = ids.length - 1; count > 0; count--) {
		const candidate = `${ids.slice(0, count).join(" ")} +${ids.length - count}`;
		if (visibleWidth(candidate) <= width) return candidate;
	}
	const overflow = `+${ids.length}`;
	if (visibleWidth(overflow) <= width) return overflow;
	return truncateToWidth(ids[0], width, "");
}

function detailKey(detail: DensityCardText): string {
	return JSON.stringify(detail);
}

function detailWidth(detail: DensityCardText): number {
	return typeof detail === "string"
		? visibleWidth(detail)
		: detail.reduce((width, span) => width + visibleWidth(span.text), 0);
}

/** A non-owning presentation of adjacent terminal polls and background warnings in transcript order. */
export class DenseBashRun implements DensityCardSource {
	readonly densityGroup = true;
	private readonly folds: DensityRunFold;
	private members: readonly DenseBashMember[] = [];
	private revision = nextRenderRevision();

	constructor(parent: DensityFold) {
		this.folds = new DensityRunFold(parent);
	}

	setMembers(members: readonly DenseBashMember[], folds: readonly DensityFold[]): void {
		if (
			this.members.length === members.length &&
			this.members.every((member, index) => {
				const next = members[index];
				return (
					member.sourceRevision !== undefined &&
					next.sourceRevision !== undefined &&
					member.card === next.card &&
					member.sourceRevision === next.sourceRevision &&
					member.kind === next.kind &&
					(member.kind === "view" ||
						(next.kind === "poll" &&
							member.poll.exitKey === next.poll.exitKey &&
							member.poll.bodyFingerprint === next.poll.bodyFingerprint &&
							JSON.stringify(member.poll.notices) === JSON.stringify(next.poll.notices) &&
							JSON.stringify(member.view) === JSON.stringify(next.view)))
				);
			})
		)
			return;
		this.members = members;
		this.folds.join(folds);
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		return this.folds.open(
			this.members.some((member) => member.view.kind === "bash-output") ? "bash-output" : "shell",
			this.members.some((member) =>
				member.kind === "poll"
					? member.card.summarySnapshot.expanded
					: member.card instanceof ToolExecutionComponent
						? member.card.summarySnapshot.expanded
						: member.card.densityExpanded,
			),
		);
	}

	setExpanded(expanded: boolean): void {
		this.folds.set(expanded);
	}

	toggleDensityMember(index: number): void {
		this.folds.toggleMember(index, this.members[index].view.kind);
	}

	renderDensitySummary(width: number, grouped: boolean): string[] {
		const view = this.renderDensityCard(width, { grouped, expanded: false });
		const style = densityCardStyle({ colorFrames: false, colorNames: false, colorIcons: false }, view.kind);
		return [densityCardHeading(view.kind, view.heading, style)];
	}

	renderDensityCard(width: number, { expanded }: { readonly grouped: boolean; readonly expanded: boolean }) {
		if (expanded) {
			const [first, ...rest] = this.members.map(({ view, status, statusGlyph }) => ({
				...view,
				status,
				statusGlyph,
			}));
			return densityNestView(first, rest, (index, view) => this.folds.memberOpen(index, view.kind));
		}

		const first = this.members[0];
		const kind: DensityCardKind = this.members.some((member) => member.view.kind === "bash-output")
			? "bash-output"
			: "shell";
		const outcome = (member: DenseBashMember) =>
			member.kind === "poll"
				? { processStatus: member.poll.processStatus, exitCode: member.poll.exitCode }
				: member.outcome;
		const firstOutcome = outcome(first);
		const sameOutcome =
			firstOutcome !== undefined &&
			this.members.every((member) => {
				const current = outcome(member);
				return (
					current !== undefined &&
					current.processStatus === firstOutcome.processStatus &&
					current.exitCode === firstOutcome.exitCode
				);
			});
		const ids = [
			...new Set(
				this.members.flatMap((member) => {
					const sessionId = denseBashMemberSessionId(member);
					return sessionId ? [displayBashSessionId(sessionId)] : [];
				}),
			),
		];
		const hasWarning = this.members.some(
			(member) => member.kind === "view" && member.card instanceof TerminalBackgroundNotice,
		);
		const sharedDetails: DensityCardText[] = [];
		const firstDetail = first.view.heading.details?.[0];
		if (
			firstDetail !== undefined &&
			(sameOutcome ||
				(first.kind === "view" &&
					!first.testCounts &&
					this.members.every(
						(member) =>
							member.kind === "view" &&
							!member.testCounts &&
							JSON.stringify(member.view.heading.details) === JSON.stringify(first.view.heading.details),
					)))
		) {
			sharedDetails.push(firstDetail);
		}
		for (const member of this.members) {
			if (
				(member.kind === "poll" && member.poll.testLabel !== undefined) ||
				(member.kind === "view" && member.testCounts)
			)
				continue;
			const { view } = member;
			for (const detail of view.heading.details?.slice(1) ?? []) {
				const key = detailKey(detail);
				if (!sharedDetails.some((existing) => detailKey(existing) === key)) sharedDetails.push(detail);
			}
		}
		const status = sameOutcome ? first.status : undefined;
		const glyph = hasWarning ? "!" : sameOutcome ? first.statusGlyph : "~";
		const fixedWidth = visibleWidth("bash ") + (glyph ? visibleWidth(glyph) + 1 : 0);
		const widthOfDetails = sharedDetails.reduce((sum, detail) => sum + detailWidth(detail), 0);
		const separatorWidth = sharedDetails.length > 0 ? 3 + widthOfDetails + 3 * (sharedDetails.length - 1) : 0;
		const identityWidth = Math.max(0, width - fixedWidth - separatorWidth);
		return {
			format: "structured" as const,
			kind,
			heading: {
				identity: compactIds(ids, identityWidth),
				details: sharedDetails,
			},
			status,
			statusGlyph: glyph,
			body: [],
			sections: [],
		};
	}

	render(_width: number): string[] {
		return this.renderDensitySummary(120, false);
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		return this.members[0]?.card.getBackgroundPainter();
	}

	getRenderRevision(): number | undefined {
		let revision = Math.max(this.revision, this.folds.revision);
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
