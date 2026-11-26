import { type DensityCardStatus, type DensityCardText, nextRenderRevision } from "@earendil-works/pi-tui";
import type { AssistantNativeSearchMetadata } from "./assistant-message.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import type { AssistantDensityCard } from "./assistant-density-card.ts";
import type { DensityFold } from "./density-fold.ts";
import { densityNestView, DensityRunFold } from "./density-nest.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

/** A native search card and its structured projection within a consecutive run. */
interface DenseSearchMember {
	readonly card: AssistantDensityCard;
	readonly metadata: AssistantNativeSearchMetadata;
	readonly sourceRevision: number;
}

function memberStatus(metadata: AssistantNativeSearchMetadata): DensityCardStatus | undefined {
	switch (metadata.details.status) {
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "in_progress":
		case "searching":
			return "running";
		default:
			return undefined;
	}
}

/** Presents consecutive native search cards with shared framing and independent member folds. */
export class DenseSearchRun implements DensityCardSource {
	readonly densityGroup = true;
	private readonly folds: DensityRunFold;
	private members: readonly DenseSearchMember[] = [];
	private revision = nextRenderRevision();

	constructor(parent: DensityFold) {
		this.folds = new DensityRunFold(parent);
	}

	setMembers(
		cards: readonly AssistantDensityCard[],
		metadata: readonly AssistantNativeSearchMetadata[],
		folds: readonly DensityFold[],
	): void {
		const members = cards.map((card, index): DenseSearchMember => ({
			card,
			metadata: metadata[index],
			sourceRevision: card.getRenderRevision(),
		}));
		if (
			this.members.length === members.length &&
			this.members.every(
				(member, index) =>
					member.card === members[index].card && member.sourceRevision === members[index].sourceRevision,
			)
		) {
			return;
		}
		this.members = members;
		this.folds.join(folds);
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		return this.folds.open(
			"search",
			this.members.some(({ card }) => card.densityExpanded),
		);
	}

	setExpanded(expanded: boolean): void {
		this.folds.set(expanded);
	}

	toggleDensityMember(index: number): void {
		this.folds.toggleMember(index, "search");
	}

	renderDensitySummary(width: number): string[] {
		const view = this.renderDensityCard(width, { grouped: true, expanded: false });
		return [
			densityCardHeading(
				view.kind,
				view.heading,
				densityCardStyle({ colorFrames: false, colorNames: false, colorIcons: false }, view.kind),
			),
		];
	}

	renderDensityCard(width: number, { expanded }: { readonly grouped: boolean; readonly expanded: boolean }) {
		if (expanded) {
			const [first, ...rest] = this.members.map(({ card }) => {
				const view = card.renderDensityCard(width, { grouped: true, expanded: true });
				if (view?.format !== "structured" || view.kind !== "search") {
					throw new TypeError("Dense search runs require structured search cards");
				}
				return view;
			});
			return densityNestView(first, rest, (index, view) => this.folds.memberOpen(index, view.kind));
		}

		const statuses = this.members.map(({ metadata }) => memberStatus(metadata));
		const [firstStatus] = statuses;
		const sharedStatus = statuses.every((status) => status === firstStatus) ? firstStatus : undefined;
		const sources: DensityCardText = this.members.map(({ metadata }) => {
			const count = metadata.sourceCount;
			return { text: `${count} ${count === 1 ? "source" : "sources"}` };
		});
		return {
			format: "structured" as const,
			kind: "search" as const,
			heading: { details: sources.map((source) => [source]) },
			...(sharedStatus === undefined ? {} : { status: sharedStatus }),
			...(sharedStatus === undefined ? { statusGlyph: "~" } : {}),
			body: [],
			sections: [],
		};
	}

	render(width: number): string[] {
		return this.renderDensitySummary(width);
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		return undefined;
	}

	getRenderRevision(): number {
		return Math.max(this.revision, this.folds.revision);
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}
}
