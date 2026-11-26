import {
	nextRenderRevision,
	type DensityCardRenderOptions,
	type DensityCardStructuredView,
	type DensityCardText,
	type DensityCardView,
} from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
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
	private readonly localExpansionRevisions = new Map<ToolExecutionComponent, number>();
	private localExpanded: boolean | undefined;
	private localRevision = nextRenderRevision();

	get densityExpanded(): boolean {
		this.syncGlobalExpansion();
		return this.localExpanded ?? this.ownerViews.every(({ owner }) => owner.summarySnapshot.expanded);
	}

	get densityGroup(): boolean {
		return this.mode === "group";
	}

	setFile(file: PatchFileView): void {
		this.syncGlobalExpansion();
		this.ownerViews = [file];
		this.singleView = file.view;
		this.mode = "file";
		this.groupMembers = [];
		this.syncExpansionOwners();
	}

	setFailure(owner: ToolExecutionComponent, view: DensityCardStructuredView): void {
		this.syncGlobalExpansion();
		if (this.ownerViews[0]?.owner !== owner) {
			this.localExpansionRevisions.clear();
			this.localExpanded = undefined;
		}
		this.ownerViews = [{ owner, view, path: "", label: "", suffix: undefined }];
		this.singleView = view;
		this.mode = "failure";
		this.groupMembers = [];
		this.syncExpansionOwners();
	}

	setGroup(cards: readonly PatchDensityCard[]): void {
		this.syncGlobalExpansion();
		const membersChanged =
			cards.length !== this.groupMembers.length || cards.some((card, index) => this.groupMembers[index] !== card);
		this.groupMembers = cards;
		this.ownerViews = cards.flatMap((card) => card.ownerViews);
		this.singleView = undefined;
		this.mode = "group";
		if (membersChanged) this.localRevision = nextRenderRevision();
		this.syncExpansionOwners();
	}

	setExpanded(expanded: boolean): void {
		this.syncGlobalExpansion();
		const globallyExpanded = this.ownerViews.every(({ owner }) => owner.summarySnapshot.expanded);
		this.localExpanded = expanded === globallyExpanded ? undefined : expanded;
		this.localExpansionRevisions.clear();
		if (this.localExpanded !== undefined) {
			for (const { owner } of this.ownerViews) {
				this.localExpansionRevisions.set(owner, owner.getExpansionRevision());
			}
		}
		this.localRevision = nextRenderRevision();
	}

	toggleDensityMember(index: number): void {
		const member = this.groupMembers[index];
		if (!member) return;
		member.setExpanded(!member.densityExpanded);
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
		const allSameKind = this.ownerViews.every(({ view }) => view.kind === first.view.kind);
		const kind = allSameKind ? first.view.kind : "patched";
		const uniqueLabels = denseReadPathLabels(
			this.ownerViews.map(({ path }) => ({ path: path.split(" → ").at(-1) ?? path })),
		);
		const labels = this.ownerViews.map(({ label, path }, index) =>
			path.includes(" → ") ? label : uniqueLabels[index],
		);
		if (options.expanded) {
			const firstMember = this.groupMembers[0];
			const firstFile = firstMember?.ownerViews[0];
			if (!firstMember || !firstFile) return undefined;
			return {
				format: "structured",
				kind: firstFile.view.kind,
				heading: firstMember.densityExpanded
					? (firstFile.view.expandedHeading ?? firstFile.view.heading)
					: firstFile.view.heading,
				status: "done",
				body: firstMember.densityExpanded ? firstFile.view.body : [],
				sections: this.groupMembers.slice(1).flatMap((member) => {
					const file = member.ownerViews[0];
					if (!file) return [];
					return [
						{
							placement: "frame",
							heading: {
								kind: file.view.kind,
								heading: member.densityExpanded
									? (file.view.expandedHeading ?? file.view.heading)
									: file.view.heading,
							},
							body: member.densityExpanded ? file.view.body : [],
						},
					];
				}),
			};
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
		this.syncGlobalExpansion();
		let revision = this.localRevision;
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

	private syncExpansionOwners(): void {
		if (this.localExpanded === undefined) {
			this.localExpansionRevisions.clear();
			return;
		}
		const owners = new Set(this.ownerViews.map(({ owner }) => owner));
		for (const owner of this.localExpansionRevisions.keys()) {
			if (!owners.has(owner)) this.localExpansionRevisions.delete(owner);
		}
		for (const owner of owners) {
			if (!this.localExpansionRevisions.has(owner)) {
				this.localExpansionRevisions.set(owner, owner.getExpansionRevision());
			}
		}
	}

	private syncGlobalExpansion(): void {
		if (
			this.localExpanded !== undefined &&
			[...this.localExpansionRevisions].some(([owner, revision]) => owner.getExpansionRevision() !== revision)
		) {
			this.localExpanded = undefined;
			this.localExpansionRevisions.clear();
		}
	}
}
