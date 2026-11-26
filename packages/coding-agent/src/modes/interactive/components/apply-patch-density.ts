import {
	nextRenderRevision,
	type DensityCardRenderOptions,
	type DensityCardStructuredView,
	type DensityCardText,
	type DensityCardView,
} from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
import type { DensityFold } from "./density-fold.ts";
import { densityNestView, revealJoiningMembers } from "./density-nest.ts";
import { denseReadPathLabels } from "./dense-read-paths.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import type { ToolDisplayColors } from "../../../core/settings-manager.ts";

export type PatchFileView = {
	readonly owner: ToolExecutionComponent;
	readonly view: DensityCardStructuredView;
	readonly path: string;
	readonly label: string;
	readonly suffix: DensityCardText | undefined;
};

const defaultColors: ToolDisplayColors = { colorFrames: false, colorNames: false, colorIcons: false };

/** A single file, diagnostic, or grouped patch projection over persisted tool cards. */
export class PatchDensityCard implements DensityCardSource {
	private ownerViews: readonly PatchFileView[] = [];
	private singleView: DensityCardStructuredView | undefined;
	private mode: "file" | "failure" | "group" = "file";
	private groupMembers: readonly PatchDensityCard[] = [];
	private localRevision = nextRenderRevision();
	private readonly fold: DensityFold;
	private readonly toolFold: DensityFold | undefined;

	constructor(fold: DensityFold, toolFold?: DensityFold) {
		this.fold = fold;
		this.toolFold = toolFold;
	}

	get densityExpanded(): boolean {
		const kind = this.foldKind;
		const fallback = this.defaultExpanded;
		if (this.densityGroup) return this.fold.nestOpen(kind, fallback);
		return this.fold.choice ?? this.toolFold?.choice ?? this.fold.defaultOpen(kind, fallback);
	}

	private get memberExpanded(): boolean {
		return (
			this.fold.choice ?? this.toolFold?.memberChoice ?? this.fold.defaultOpen(this.foldKind, this.defaultExpanded)
		);
	}

	private get foldKind(): DensityCardStructuredView["kind"] {
		const first = this.ownerViews[0]?.view.kind ?? "patched";
		return this.ownerViews.every(({ view }) => view.kind === first) ? first : "patched";
	}

	private get defaultExpanded(): boolean {
		return this.ownerViews.every(({ owner }) => owner.summarySnapshot.expanded);
	}

	get densityGroup(): boolean {
		return this.mode === "group";
	}

	setFile(file: PatchFileView): void {
		this.ownerViews = [file];
		this.singleView = file.view;
		this.mode = "file";
		this.groupMembers = [];
	}

	setFailure(owner: ToolExecutionComponent, view: DensityCardStructuredView): void {
		this.ownerViews = [{ owner, view, path: "", label: "", suffix: undefined }];
		this.singleView = view;
		this.mode = "failure";
		this.groupMembers = [];
	}

	setGroup(cards: readonly PatchDensityCard[]): void {
		const membersChanged =
			cards.length !== this.groupMembers.length || cards.some((card, index) => this.groupMembers[index] !== card);
		if (membersChanged) {
			const previous = new Set(this.groupMembers);
			const joining = new Map<DensityFold, boolean>();
			for (const card of cards) {
				if (previous.has(card) || !card.toolFold) continue;
				joining.set(card.toolFold, card.memberExpanded || joining.get(card.toolFold) === true);
			}
			revealJoiningMembers(this.fold, joining);
			this.localRevision = nextRenderRevision();
		}
		this.groupMembers = cards;
		this.ownerViews = cards.flatMap((card) => card.ownerViews);
		this.singleView = undefined;
		this.mode = "group";
	}

	setExpanded(expanded: boolean): void {
		this.fold.set(expanded);
	}

	toggleDensityMember(index: number): void {
		const member = this.groupMembers[index];
		if (!member) return;
		member.setExpanded(!member.memberExpanded);
		this.localRevision = nextRenderRevision();
	}

	renderDensitySummary(width: number, grouped: boolean): string[] {
		const view = this.renderDensityCard(width, { grouped, expanded: false });
		if (view?.format !== "structured") return [];
		return [densityCardHeading(view.kind, view.heading, densityCardStyle(defaultColors, view.kind))];
	}

	renderDensityCard(_width: number, options: DensityCardRenderOptions): DensityCardView | undefined {
		if (this.mode !== "group") return this.singleView;
		const [first] = this.ownerViews;
		if (!first) return undefined;
		const kind = this.foldKind;
		const uniqueLabels = denseReadPathLabels(
			this.ownerViews.map(({ path }) => ({ path: path.split(" → ").at(-1) ?? path })),
		);
		const labels = this.ownerViews.map(({ label, path }, index) =>
			path.includes(" → ") ? label : uniqueLabels[index],
		);
		if (options.expanded) {
			return densityNestView(
				{ ...first.view, status: "done" },
				this.ownerViews.slice(1).map(({ view }) => ({ ...view, status: undefined })),
				(index) => this.groupMembers[index].memberExpanded,
			);
		}
		return {
			format: "structured",
			kind,
			heading: { identity: labels.join(" ") },
			status: "done",
			body: [],
			sections: [],
		};
	}

	render(width: number): string[] {
		return this.renderDensitySummary(width, false);
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		return this.ownerViews[0]?.owner.getBackgroundPainter();
	}

	getRenderRevision(): number | undefined {
		let revision = Math.max(this.localRevision, this.fold.revision, this.toolFold?.revision ?? 0);
		for (const { owner } of this.ownerViews) {
			const current = owner.getRenderRevision();
			if (current === undefined) return undefined;
			revision = Math.max(revision, current);
		}
		return revision;
	}

	invalidate(): void {
		this.localRevision = nextRenderRevision();
	}
}
