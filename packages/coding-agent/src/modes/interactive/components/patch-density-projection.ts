import path from "node:path";
import type { DensityCardStructuredView } from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "./tool-execution.ts";
import { PatchDensityCard, type PatchFileView } from "./apply-patch-density.ts";

export { PatchDensityCard };

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
			card.setFile(file);
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
	if (view.status === "failed" && view.sections.length === 0) return [];
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
