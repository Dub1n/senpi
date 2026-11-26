import type { DensityCardBlock, DensityCardStructuredView } from "@earendil-works/pi-tui";
import type { DensityFold } from "./density-fold.ts";

export type DensityMemberControls = {
	readonly first: boolean;
	readonly sections: readonly (number | undefined)[];
};

type NestView = DensityCardStructuredView & { readonly memberControls: DensityMemberControls };

function hasBody(blocks: readonly DensityCardBlock[]): boolean {
	return blocks.some(
		(block) =>
			block.type === "rich" ||
			block.lines.some((line) => (typeof line === "string" ? line.length : line.some(({ text }) => text.length))),
	);
}

export function hasDensityMemberBody(view: DensityCardStructuredView): boolean {
	return hasBody(view.body) || view.sections.some((section) => hasBody(section.body));
}

/** Flatten member-owned sections into one frame. Only actual member headings are fold controls. */
export function densityNestView(
	first: DensityCardStructuredView,
	rest: readonly DensityCardStructuredView[],
	isOpen: (index: number, view: DensityCardStructuredView) => boolean,
): NestView {
	const firstHasBody = hasDensityMemberBody(first);
	const firstOpen = firstHasBody && isOpen(0, first);
	const sections = firstOpen ? [...first.sections] : [];
	const memberIndexes: (number | undefined)[] = sections.map(() => undefined);
	for (const [index, view] of rest.entries()) {
		const hasDetail = hasDensityMemberBody(view);
		const open = hasDetail && isOpen(index + 1, view);
		memberIndexes.push(hasDetail ? index + 1 : undefined);
		sections.push({
			placement: "frame",
			heading: {
				kind: view.kind,
				heading: open ? (view.expandedHeading ?? view.heading) : view.heading,
				status: view.status,
				statusGlyph: view.statusGlyph,
			},
			body: open ? view.body : [],
		});
		if (open) {
			for (const section of view.sections) {
				memberIndexes.push(undefined);
				sections.push(section);
			}
		}
	}
	return {
		...first,
		heading: firstOpen ? (first.expandedHeading ?? first.heading) : first.heading,
		expandedHeading: undefined,
		body: firstOpen ? first.body : [],
		sections,
		memberControls: { first: firstHasBody, sections: memberIndexes },
	};
}

/** Consume requests on arrival, never on re-render or on reopening a closed parent. */
export function revealJoiningMembers(parent: DensityFold, joining: ReadonlyMap<DensityFold, boolean>): void {
	let reveal = false;
	for (const [fold, openMember] of joining) {
		if (fold.takeReveal() && openMember) reveal = true;
	}
	if (reveal) parent.set(true);
}

/** Independent parent and member state over the existing family-specific transcript projection. */
export class DensityRunFold {
	private readonly parent: DensityFold;
	private members: readonly DensityFold[] = [];

	constructor(parent: DensityFold) {
		this.parent = parent;
	}

	join(members: readonly DensityFold[]): void {
		const previous = new Set(this.members);
		const joining = new Map<DensityFold, boolean>();
		for (const fold of members) if (!previous.has(fold)) joining.set(fold, fold.memberChoice === true);
		revealJoiningMembers(this.parent, joining);
		this.members = members;
	}

	open(kind: DensityCardStructuredView["kind"], fallback: boolean): boolean {
		return this.parent.nestOpen(kind, fallback);
	}

	set(expanded: boolean): void {
		this.parent.set(expanded);
	}

	memberOpen(index: number, kind: DensityCardStructuredView["kind"]): boolean {
		const fold = this.members[index];
		return fold.memberChoice ?? fold.defaultOpen(kind, true);
	}

	toggleMember(index: number, kind: DensityCardStructuredView["kind"]): boolean {
		const expanded = !this.memberOpen(index, kind);
		this.members[index].set(expanded);
		return expanded;
	}

	get revision(): number {
		return this.members.reduce((latest, fold) => Math.max(latest, fold.revision), this.parent.revision);
	}
}
