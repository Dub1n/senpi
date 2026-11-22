import type { DensityCardView } from "@earendil-works/pi-tui";

const summaries = new WeakMap<object, DensityCardView>();

export function rememberDensityCardSummary(owner: object, view: DensityCardView): void {
	summaries.set(owner, {
		title: view.title,
		...(view.name === undefined ? {} : { name: view.name }),
		...(view.kind === undefined ? {} : { kind: view.kind }),
		...(view.expandedTitle === undefined ? {} : { expandedTitle: view.expandedTitle }),
		...(view.status === undefined ? {} : { status: view.status }),
		...(view.statusGlyph === undefined ? {} : { statusGlyph: view.statusGlyph }),
		...(view.foldedDetails === undefined ? {} : { foldedDetails: view.foldedDetails }),
		renderContent: () => [],
		sections: [],
	});
}

export function rememberedDensityCardSummary(owner: object): DensityCardView | undefined {
	return summaries.get(owner);
}

export function forgetDensityCardSummary(owner: object): void {
	summaries.delete(owner);
}
