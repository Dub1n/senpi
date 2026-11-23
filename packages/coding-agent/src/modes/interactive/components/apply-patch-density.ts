import path from "node:path";
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

type PatchFileView = {
	readonly owner: ToolExecutionComponent;
	readonly view: DensityCardStructuredView;
	readonly path: string;
	readonly label: string;
	readonly suffix: DensityCardText | undefined;
	readonly key?: string;
};

const defaultColors: ToolDisplayColors = { colorFrames: false, colorNames: false, colorIcons: false };

/** A single file, diagnostic, or grouped patch projection over persisted tool cards. */
export class PatchDensityCard implements DensityCardSource {
	private ownerViews: readonly PatchFileView[] = [];
	private singleView: DensityCardStructuredView | undefined;
	private mode: "file" | "failure" | "group" = "file";
	private groupMembership = "";
	private readonly localExpansionRevisions = new Map<ToolExecutionComponent, number | undefined>();
	private localExpanded: boolean | undefined;
	private localRevision = nextRenderRevision();

	get densityExpanded(): boolean {
		this.syncGlobalExpansion();
		return this.localExpanded ?? this.ownerViews.every(({ owner }) => owner.summarySnapshot.expanded);
	}

	setFile(file: PatchFileView): void {
		this.ownerViews = [file];
		this.singleView = file.view;
		this.mode = "file";
		this.syncGlobalExpansion();
	}

	setFailure(owner: ToolExecutionComponent, view: DensityCardStructuredView): void {
		if (this.ownerViews[0]?.owner !== owner) {
			this.localExpansionRevisions.clear();
			this.localExpanded = undefined;
		}
		this.ownerViews = [{ owner, view, path: "", label: "", suffix: undefined }];
		this.singleView = view;
		this.mode = "failure";
		this.syncGlobalExpansion();
	}

	setGroup(cards: readonly PatchDensityCard[]): void {
		this.ownerViews = cards.flatMap((card) => card.ownerViews);
		const membership = this.ownerViews
			.map(({ owner, key }) => `${owner.presentationSnapshot.identity.toolCallId}\u0000${key ?? ""}`)
			.join("\u0001");
		if (membership !== this.groupMembership) {
			this.groupMembership = membership;
			this.localRevision = nextRenderRevision();
		}
		this.singleView = undefined;
		this.mode = "group";
		this.syncGlobalExpansion();
	}

	setExpanded(expanded: boolean): void {
		this.syncGlobalExpansion();
		const globallyExpanded = this.ownerViews.every(({ owner }) => owner.summarySnapshot.expanded);
		this.localExpanded = expanded === globallyExpanded ? undefined : expanded;
		this.localExpansionRevisions.clear();
		if (this.localExpanded !== undefined) {
			for (const { owner } of this.ownerViews) {
				this.localExpansionRevisions.set(owner, owner.getRenderRevision());
			}
		}
		this.localRevision = nextRenderRevision();
	}

	renderDensitySummary(width: number, grouped: boolean): string[] {
		const view = this.renderDensityCard(width, { grouped, expanded: false });
		if (view?.format !== "structured") return [];
		return [densityCardHeading(view.kind, view.heading, densityCardStyle(defaultColors, view.kind))];
	}

	renderDensityCard(_width: number, _options: DensityCardRenderOptions): DensityCardView | undefined {
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
		return {
			format: "structured",
			kind,
			heading: { identity: labels.join(" ") },
			status: "done",
			body: [],
			sections: this.ownerViews.map(({ view }) => ({
				placement: "frame",
				heading: {
					kind: view.kind,
					heading: view.expandedHeading ?? view.heading,
				},
				body: view.body,
			})),
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

	private syncGlobalExpansion(): void {
		const owners = new Set(this.ownerViews.map(({ owner }) => owner));
		if (
			this.localExpanded !== undefined &&
			(owners.size !== this.localExpansionRevisions.size ||
				[...owners].some((owner) => owner.getRenderRevision() !== this.localExpansionRevisions.get(owner)))
		) {
			this.localExpanded = undefined;
			this.localExpansionRevisions.clear();
		}
	}
}

export type ApplyPatchDensityProjection =
	| { readonly status: "done"; readonly files: readonly PatchDensityCard[] }
	| {
			readonly status: "failed";
			readonly failure: PatchDensityCard;
			readonly files: readonly PatchDensityCard[];
	  };

/** Retain the original tool result while projecting applied patch files as independent cards. */
export class PatchDensityProjection {
	private readonly fileCards = new Map<string, PatchDensityCard>();
	private readonly failureCard = new PatchDensityCard();

	update(owner: ToolExecutionComponent, view: DensityCardStructuredView): ApplyPatchDensityProjection | undefined {
		const files = patchFileViews(owner, view);
		const occurrences = new Map<string, number>();
		const active = new Set<string>();
		const fileCards = files.map((file) => {
			const baseKey = `${file.view.kind}\u0000${file.path}`;
			const occurrence = occurrences.get(baseKey) ?? 0;
			occurrences.set(baseKey, occurrence + 1);
			const key = `${baseKey}\u0000${occurrence}`;
			active.add(key);
			let card = this.fileCards.get(key);
			if (!card) {
				card = new PatchDensityCard();
				this.fileCards.set(key, card);
			}
			card.setFile({ ...file, key });
			return card;
		});
		for (const key of this.fileCards.keys()) {
			if (!active.has(key)) this.fileCards.delete(key);
		}

		if (view.status === "failed") {
			this.failureCard.setFailure(owner, { ...view, sections: [] });
			return { status: "failed", failure: this.failureCard, files: fileCards };
		}
		if (view.status !== "done" || files.length === 0) return undefined;
		return { status: "done", files: fileCards };
	}
}

function patchFileViews(owner: ToolExecutionComponent, view: DensityCardStructuredView): PatchFileView[] {
	if (view.sections.length > 0) {
		return view.sections.flatMap((section) => {
			if (!("kind" in section.heading) || !isPatchKind(section.heading.kind)) return [];
			const heading = section.heading.heading;
			const path = heading.identity;
			if (!path) return [];
			const suffix = heading.identitySuffix;
			const label = shortPath(path);
			const foldedSuffix = typeof suffix === "string" && suffix.startsWith(":") ? suffix.slice(1) : suffix;
			return [
				{
					owner,
					path,
					label,
					suffix,
					view: {
						format: "structured",
						kind: section.heading.kind,
						heading: { identity: label, ...(foldedSuffix === undefined ? {} : { details: [foldedSuffix] }) },
						expandedHeading: heading,
						status: section.heading.status ?? "done",
						statusGlyph: section.heading.statusGlyph,
						body: section.body,
						sections: [],
					},
				},
			];
		});
	}
	if (!isPatchKind(view.kind)) return [];
	const path = view.expandedHeading?.identity;
	if (!path) return [];
	const suffix = view.expandedHeading?.identitySuffix;
	return [
		{
			owner,
			view,
			path,
			label: view.heading.identity ?? shortPath(path),
			suffix,
		},
	];
}

function shortPath(value: string): string {
	return value
		.split(" → ")
		.map((part) => path.basename(part))
		.join(" → ");
}

function isPatchKind(kind: DensityCardStructuredView["kind"]): boolean {
	return kind === "added" || kind === "edited" || kind === "deleted";
}
