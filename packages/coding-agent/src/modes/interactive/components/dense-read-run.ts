import { pathToFileURL } from "node:url";
import {
	type DensityCardStatus,
	type DensityCardStructuredView,
	type DensityCardSpan,
	nextRenderRevision,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getCompactReadClassification, readRenderers } from "../../../core/tools/renderers/read.ts";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import { denseReadPathLabels } from "./dense-read-paths.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

export interface DenseReadMember {
	readonly card: ToolExecutionComponent;
	readonly path: string;
	readonly kind: "read" | "skill";
	readonly skill?: string;
}

/** Classify only from call identity, result metadata and read args, never from painted text. */
export function denseReadProjection(child: unknown): "hidden" | DenseReadMember | undefined {
	if (!(child instanceof ToolExecutionComponent)) return undefined;
	const snapshot = child.summarySnapshot;
	if (snapshot.name === "todo") {
		const { details, args } = snapshot;
		const operation =
			(details && typeof details === "object" && "op" in details ? details.op : undefined) ??
			(args && typeof args === "object" && "op" in args ? args.op : undefined);
		return !snapshot.pending && !snapshot.failed && operation === "view" ? "hidden" : undefined;
	}
	if (snapshot.name !== "read" || snapshot.hasVisibleImages || !snapshot.args || typeof snapshot.args !== "object") {
		return undefined;
	}
	// A replacement renderer may not provide built-in read sections. Leave it on the original card.
	const { toolDefinition: renderer, cwd } = child.presentationSnapshot.identity;
	if (
		(renderer?.renderResult && renderer.renderResult !== readRenderers.renderResult) ||
		(renderer?.renderCall && renderer.renderCall !== readRenderers.renderCall)
	)
		return undefined;
	const path: unknown = Reflect.get(snapshot.args, "file_path") ?? Reflect.get(snapshot.args, "path");
	if (typeof path !== "string" || !path) return undefined;
	const classification = getCompactReadClassification({ path }, cwd);
	if (classification?.kind === "skill") {
		return { card: child, kind: "skill", path, skill: classification.label };
	}
	return { card: child, kind: "read", path };
}

function readStatus(member: DenseReadMember): DensityCardStatus {
	const { pending, started, failed } = member.card.summarySnapshot;
	return failed ? "failed" : pending ? (started ? "running" : "pending") : "done";
}

/** Non-owning presentation of consecutive reads. Session history and expansion remain on the originals. */
export class DenseReadRun implements DensityCardSource {
	private members: readonly DenseReadMember[] = [];
	private labels: readonly string[] = [];
	private revision = nextRenderRevision();

	setMembers(members: readonly DenseReadMember[]): void {
		if (
			this.members.length === members.length &&
			this.members.every(
				(member, i) =>
					member.card === members[i].card &&
					member.kind === members[i].kind &&
					member.skill === members[i].skill &&
					member.path === members[i].path,
			)
		)
			return;
		this.members = members;
		this.labels = denseReadPathLabels(members);
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		return this.members.some(({ card }) => card.summarySnapshot.expanded);
	}

	setExpanded(expanded: boolean): void {
		for (const { card } of this.members) {
			if (card.summarySnapshot.expanded !== expanded) card.setExpanded(expanded);
		}
	}

	renderDensitySummary(width: number, grouped: boolean): string[] {
		const view = this.renderDensityCard(width, { grouped, expanded: false });
		return [
			densityCardHeading(
				view.kind,
				view.heading,
				densityCardStyle({ colorFrames: false, colorNames: false, colorIcons: false }, view.kind),
			),
		];
	}

	renderDensityCard(
		width: number,
		{ grouped, expanded }: { readonly grouped: boolean; readonly expanded: boolean },
	): DensityCardStructuredView {
		if (!expanded) {
			const kind = this.members[0].kind;
			const statuses = this.members.map(readStatus);
			const [first] = statuses;
			const shared = statuses.every((status) => status === first) ? first : undefined;
			const failedCount = statuses.filter((status) => status === "failed").length;
			const files: DensityCardSpan[] = this.labels.flatMap((label, i) => [
				...(i ? [{ text: " " }] : []),
				{
					text: label,
					strikethrough: statuses[i] === "failed",
					link: pathToFileURL(
						resolveToCwd(this.members[i].path, this.members[i].card.presentationSnapshot.identity.cwd),
					).href,
				},
			]);
			const failure = `${failedCount} failed`;
			const suffix = ` · ${failure}`;
			const titleWidth = width - 2 - kind.length - 3;
			let remaining = Math.max(0, titleWidth - visibleWidth(suffix));
			const shortened = files.flatMap((span) => {
				if (remaining <= 0) return [];
				const text = truncateToWidth(span.text, remaining, "…");
				remaining -= visibleWidth(text);
				return [{ ...span, text }];
			});
			return {
				format: "structured",
				kind,
				heading: { details: shared !== undefined || failedCount === 0 ? [files] : [shortened, failure] },
				status: shared,
				statusGlyph: shared === undefined ? "~" : undefined,
				body: [],
				sections: [],
			};
		}
		const views = this.members.map((member): DensityCardStructuredView => {
			const detail = member.card.renderDensityCard(width, { grouped, expanded: true });
			if (detail?.format === "structured") return detail;
			return {
				format: "structured",
				kind: member.kind,
				heading: { details: [member.skill ?? member.path] },
				status: detail?.status ?? readStatus(member),
				body: [],
				sections: [],
			};
		});
		const [first, ...rest] = views;
		return {
			...first,
			heading: first.expandedHeading ?? first.heading,
			sections: rest.map((view) => ({
				heading: {
					kind: view.kind,
					heading: view.expandedHeading ?? view.heading,
					status: view.status,
					statusGlyph: view.statusGlyph,
				},
				placement: "frame",
				body: view.body,
			})),
		};
	}

	// Only the shared dense row renders this adapter; fallback never owns the underlying cards.
	render(width: number): string[] {
		return this.renderDensitySummary(width, false);
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		const first = this.members[0];
		return first?.card.getBackgroundPainter();
	}

	getRenderRevision(): number | undefined {
		let revision = this.revision;
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
