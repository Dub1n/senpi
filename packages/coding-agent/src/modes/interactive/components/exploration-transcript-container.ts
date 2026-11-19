import {
	type Component,
	Container,
	claimFrameRow,
	currentRenderRevision,
	renderAtFrameRow,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolDisplayDensity } from "../../../core/settings-manager.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { type ExplorationCall, explorationCall } from "./exploration-call.ts";
import { ExplorationGroup } from "./exploration-group.ts";
import { projectRulesOfCall } from "./exploration-rules.ts";
import {
	ProgressiveTranscriptContainer,
	type ProgressiveTranscriptOptions,
} from "./progressive-transcript-container.ts";
import { ToolDensityRow } from "./tool-density-row.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

/**
 * Original children remain the lifecycle/ID/anchor model. A non-owning projection groups their
 * presentation before progressive hydration, so compact frames never render hidden tool results.
 * Re-projecting also handles partial args, late text, and visibility changes without moving cards.
 */
export class ExplorationTranscriptContainer extends Container {
	private readonly display: ProgressiveTranscriptContainer;
	private readonly requestRender: () => void;
	private density: ToolDisplayDensity = "default";
	private readonly densityRows = new WeakMap<ToolExecutionComponent, ToolDensityRow>();
	private densityProjection:
		| {
				readonly source: readonly Component[];
				readonly projected: Component[];
				readonly clock: number;
		  }
		| undefined;
	private groups = new WeakMap<ToolExecutionComponent, ExplorationGroup>();
	/** A card's exploration call is a function of its state, so it is recomputed only after the card changes. */
	private calls = new WeakMap<
		ToolExecutionComponent,
		{ readonly revision: number; readonly call: ExplorationCall | undefined }
	>();

	/** Last projection, reused while the same children exist and no revisioned component has changed. */
	private projection:
		| { readonly source: readonly Component[]; readonly clock: number; readonly projected: Component[] }
		| undefined;

	constructor(options: ProgressiveTranscriptOptions) {
		super();
		this.display = new ProgressiveTranscriptContainer(options);
		this.requestRender = options.requestRender;
	}

	/** Select the collapsed transcript presentation. */
	setToolDisplayDensity(density: ToolDisplayDensity): void {
		if (this.density === density) return;
		this.density = density;
		this.densityProjection = undefined;
		this.display.invalidateCache();
	}

	override render(width: number): string[] {
		this.display.children = this.density === "default" ? this.project() : this.projectDensity();
		return renderAtFrameRow(this.display, width, claimFrameRow(this));
	}

	private projectDensity(): Component[] {
		const memo = this.densityProjection;
		const clock = currentRenderRevision();
		const grouped = this.density === "grouped";
		if (memo && (!grouped || memo.clock === clock) && sameComponents(memo.source, this.children)) {
			return memo.projected;
		}

		const projected: Component[] = [];
		let previous: ToolDensityRow | undefined;
		let previousFirst = true;
		for (const child of this.children) {
			if (grouped && child instanceof AssistantMessageComponent && !child.hasTranscriptRows) continue;
			const row = child instanceof ToolExecutionComponent ? this.densityRowOf(child) : null;
			const joins = grouped && previous !== undefined && row !== null;
			previous?.setLayout(grouped, previousFirst, !joins);
			previous = row ?? undefined;
			previousFirst = !joins;
			projected.push(row ?? child);
		}
		previous?.setLayout(grouped, previousFirst, true);
		this.densityProjection = { source: [...this.children], projected, clock: currentRenderRevision() };
		return projected;
	}

	private densityRowOf(card: ToolExecutionComponent): ToolDensityRow {
		const cached = this.densityRows.get(card);
		if (cached !== undefined) return cached;
		const row = new ToolDensityRow(card, this.requestRender);
		this.densityRows.set(card, row);
		return row;
	}

	/**
	 * Grouping reads card state (exploration call, detail text, rules). Every such change moves the
	 * render revision clock, so an unmoved clock over the same children proves the grouping is unchanged.
	 */
	private project(): Component[] {
		const memo = this.projection;
		if (memo && memo.clock === currentRenderRevision() && sameComponents(memo.source, this.children)) {
			return memo.projected;
		}
		const projected: Component[] = [];
		let group: ExplorationGroup | undefined;
		let members: Component[] = [];
		let calls: ExplorationGroup["calls"] = [];
		let rules: string[] = [];
		// Members are handed to the group once it is complete: per added member it rescanned the group.
		const closeGroup = (): void => {
			group?.setMembers(members, calls, rules);
			group = undefined;
		};
		for (const child of this.children) {
			const call = child instanceof ToolExecutionComponent ? this.explorationCallOf(child) : undefined;
			if (child instanceof ToolExecutionComponent && call) {
				if (!group) {
					group = this.groups.get(child) ?? new ExplorationGroup();
					this.groups.set(child, group);
					projected.push(group);
					members = [];
					calls = [];
					rules = [];
				}
				members.push(child);
				calls.push({ component: child, call });
				continue;
			}
			const childRules =
				group && child instanceof CustomEntryComponent ? projectRulesOfCall(child, calls) : undefined;
			if (group && child instanceof AssistantMessageComponent && child.isExplorationDetail) {
				members.push(child);
			} else if (group && childRules) {
				members.push(child);
				rules = [...rules, ...childRules];
			} else {
				closeGroup();
				projected.push(child);
			}
		}
		closeGroup();
		this.projection = { source: [...this.children], clock: currentRenderRevision(), projected };
		return projected;
	}

	override handleMouse(event: TuiMouseEvent) {
		return this.display.handleMouse(event);
	}

	private explorationCallOf(child: ToolExecutionComponent): ExplorationCall | undefined {
		const revision = child.getRenderRevision();
		if (revision === undefined) return explorationCall(child);
		const cached = this.calls.get(child);
		if (cached?.revision === revision) return cached.call;
		const call = explorationCall(child);
		this.calls.set(child, { revision, call });
		return call;
	}

	/** Theme and capability changes reach the original children; the painted projection's cache must drop too. */
	override invalidate(): void {
		this.display.invalidateCache();
		this.calls = new WeakMap();
		this.densityProjection = undefined;
		super.invalidate();
	}

	override clear(): void {
		this.display.detachAll();
		this.groups = new WeakMap();
		this.projection = undefined;
		this.densityProjection = undefined;
		super.clear();
	}

	override detachAll(): void {
		this.display.detachAll();
		this.groups = new WeakMap();
		this.projection = undefined;
		this.densityProjection = undefined;
		super.detachAll();
	}

	override dispose(): void {
		this.display.detachAll();
		this.display.dispose();
		this.densityProjection = undefined;
		super.dispose();
	}
}

function sameComponents(left: readonly Component[], right: readonly Component[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}
