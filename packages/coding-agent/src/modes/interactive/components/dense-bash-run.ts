import {
	type DensityCardStatus,
	type DensityCardStructuredView,
	type DensityCardText,
	nextRenderRevision,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { denseBashPoll } from "../../../core/extensions/builtin/terminal/tools/render.ts";
import type { DenseBashPollView } from "../../../core/extensions/builtin/terminal/tools/render.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import type { DensityFold } from "./density-fold.ts";
import { densityNestView, DensityRunFold } from "./density-nest.ts";
import { displayBashSessionId, type TerminalBackgroundNotice } from "./terminal-background-notice.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

interface DenseBashPollMember {
	readonly kind: "poll";
	readonly card: ToolExecutionComponent;
	readonly sourceRevision: number | undefined;
	readonly poll: DenseBashPollView;
	readonly view: DensityCardStructuredView;
	readonly status: DensityCardStatus | undefined;
	readonly statusGlyph: string | undefined;
}

interface DenseBashWarningMember {
	readonly kind: "warning";
	readonly card: TerminalBackgroundNotice;
	readonly sourceRevision: number;
	readonly view: DensityCardStructuredView;
	readonly status?: undefined;
	readonly statusGlyph: "!";
}

export type DenseBashMember = DenseBashPollMember | DenseBashWarningMember;

function compactIds(ids: readonly string[], width: number): string {
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

/** Classify a stored bash poll while leaving screen, errors, and legacy results on their own cards. */
export function denseBashProjection(card: ToolExecutionComponent): DenseBashPollMember | undefined {
	const snapshot = card.summarySnapshot;
	if (snapshot.name !== "bash_output") return undefined;
	const { state } = card.presentationSnapshot;
	if (!state.result) return undefined;
	const args: { bash_id?: string; view?: "log" | "screen"; filter?: string } = {};
	const rawArgs = snapshot.args;
	if (rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
		const bashId: unknown = Reflect.get(rawArgs, "bash_id");
		const view: unknown = Reflect.get(rawArgs, "view");
		const filter: unknown = Reflect.get(rawArgs, "filter");
		if (typeof bashId === "string") args.bash_id = bashId;
		if (view === "log" || view === "screen") args.view = view;
		if (typeof filter === "string") args.filter = filter;
	}
	const poll = denseBashPoll(state.result, args);
	if (!poll) return undefined;
	const view = card.renderDensityCard(120, { grouped: false, expanded: true });
	if (view?.format !== "structured") return undefined;
	return {
		kind: "poll",
		card,
		sourceRevision: card.getRenderRevision(),
		poll,
		view,
		status: poll.status === "cancelled" ? undefined : poll.status,
		statusGlyph: view.statusGlyph,
	};
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
					member.card === next.card &&
					member.sourceRevision === next.sourceRevision &&
					(member.kind === "warning" ||
						(next.kind === "poll" &&
							member.poll.exitKey === next.poll.exitKey &&
							member.poll.bodyFingerprint === next.poll.bodyFingerprint &&
							JSON.stringify(member.poll.notices) === JSON.stringify(next.poll.notices) &&
							JSON.stringify(member.view.heading) === JSON.stringify(next.view.heading)))
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
			"bash-output",
			this.members.some((member) =>
				member.kind === "poll" ? member.card.summarySnapshot.expanded : member.card.densityExpanded,
			),
		);
	}

	setExpanded(expanded: boolean): void {
		this.folds.set(expanded);
	}

	toggleDensityMember(index: number): void {
		this.folds.toggleMember(index, "bash-output");
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
			return densityNestView(first, rest, (index) => this.folds.memberOpen(index, "bash-output"));
		}

		const first = this.members[0];
		const sameOutcome = this.members.every(
			(member) =>
				first.kind === "poll" &&
				member.kind === "poll" &&
				member.poll.processStatus === first.poll.processStatus &&
				member.poll.exitCode === first.poll.exitCode,
		);
		const ids = [
			...new Set(
				this.members.map((member) => (member.kind === "poll" ? member.poll.sessionId : member.card.sessionId)),
			),
		].map(displayBashSessionId);
		const hasWarning = this.members.some((member) => member.kind === "warning");
		const sharedDetails: DensityCardText[] = [];
		const firstDetail = first.view.heading.details?.[0];
		if (
			firstDetail !== undefined &&
			(sameOutcome ||
				(first.kind === "warning" &&
					this.members.every(
						(member) => member.kind === "warning" && member.view.heading.details?.[0] === firstDetail,
					)))
		) {
			sharedDetails.push(firstDetail);
		}
		for (const { view } of this.members) {
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
			kind: "bash-output" as const,
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
