import { canonicalJson, toStoreValue } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	claimFrameRow,
	currentRenderRevision,
	renderAtFrameRow,
	Spacer,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolDisplayColors, ToolDisplayDensity } from "../../../core/settings-manager.ts";
import { patchDensityCard } from "../../../core/extensions/builtin/gpt-apply-patch/density.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchToolDetails,
} from "../../../core/extensions/builtin/gpt-apply-patch/types.ts";
import { normalizeApplyPatchArguments } from "../../../core/extensions/builtin/gpt-apply-patch/params.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { PatchDensityCard, PatchDensityProjection } from "./patch-density-projection.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
import { type DenseProjectRulesMember, DenseProjectRulesRun } from "./dense-project-rules.ts";
import { denseBashProjection, DenseBashRun, type DenseBashMember } from "./dense-bash-run.ts";
import { type DenseReadMember, denseReadProjection, DenseReadRun } from "./dense-read-run.ts";
import { type ExplorationCall, explorationCall } from "./exploration-call.ts";
import { ExplorationGroup } from "./exploration-group.ts";
import { DenseWorkerModels } from "./omo-task-density.ts";
import { projectRulesOfCall } from "./exploration-rules.ts";
import {
	ProgressiveTranscriptContainer,
	type ProgressiveTranscriptOptions,
} from "./progressive-transcript-container.ts";
import { type DensityCardSource, isDensityCardSource, ToolDensityRow } from "./tool-density-row.ts";
import { TerminalBackgroundNotice } from "./terminal-background-notice.ts";
import { TerminalTestCompletion } from "./terminal-test-completion.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { theme } from "../theme/theme.ts";
import { TranscriptNotice } from "./transcript-notice.ts";
import { SystemPromptStatus } from "./system-prompt-status.ts";
import { TranscriptStatusText } from "./themed-text.ts";

function isDefaultStatusRow(child: Component | undefined): boolean {
	return (
		child instanceof TranscriptStatusText ||
		child instanceof SystemPromptStatus ||
		(child instanceof TerminalBackgroundNotice && child.isRunningStatus)
	);
}

/**
 * Original children remain the lifecycle/ID/anchor model. A non-owning projection groups their
 * presentation before progressive hydration, so compact frames never render hidden tool results.
 * Re-projecting also handles partial args, late text, and visibility changes without moving cards.
 */
export class ExplorationTranscriptContainer extends Container {
	private readonly display: ProgressiveTranscriptContainer;
	private readonly requestRender: () => void;
	private density: ToolDisplayDensity = "default";
	private densityColors: ToolDisplayColors = { colorFrames: false, colorNames: false, colorIcons: false };
	private readonly densityRows = new WeakMap<ToolExecutionComponent | DensityCardSource, ToolDensityRow>();
	private readonly denseBashRuns = new WeakMap<ToolExecutionComponent | TerminalBackgroundNotice, DenseBashRun>();
	private readonly denseReadRuns = new WeakMap<ToolExecutionComponent, DenseReadRun>();
	private readonly denseProjectRulesRuns = new WeakMap<CustomEntryComponent, DenseProjectRulesRun>();
	private patchDensityProjections = new WeakMap<ToolExecutionComponent, PatchDensityProjection>();
	private patchDensityGroups = new WeakMap<ToolExecutionComponent, PatchDensityCard>();
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

	get toolDisplayDensity(): ToolDisplayDensity {
		return this.density;
	}

	/** Select the collapsed transcript presentation. */
	setToolDisplayDensity(density: ToolDisplayDensity): void {
		if (this.density === density) return;
		this.density = density;
		this.densityProjection = undefined;
		this.display.invalidateCache();
	}

	setToolDisplayColors(colors: ToolDisplayColors): void {
		if (
			this.densityColors.colorFrames === colors.colorFrames &&
			this.densityColors.colorNames === colors.colorNames &&
			this.densityColors.colorIcons === colors.colorIcons &&
			this.densityColors.overrides === colors.overrides
		)
			return;
		this.densityColors = colors;
		if (this.density !== "default") this.display.invalidateCache();
	}

	override render(width: number): string[] {
		this.display.children = this.density === "default" ? this.project() : this.projectDensity();
		return renderAtFrameRow(this.display, width, claimFrameRow(this));
	}

	private projectDensity(): Component[] {
		const memo = this.densityProjection;
		const clock = currentRenderRevision();
		const grouped = this.density === "grouped";
		if (memo && memo.clock === clock && sameComponents(memo.source, this.children)) {
			return memo.projected;
		}

		const projected: Component[] = [];
		let previous: ToolDensityRow | undefined;
		let previousFirst = true;
		let patchRun: { readonly owner: ToolExecutionComponent; readonly files: PatchDensityCard[] }[] = [];
		let bashRun: DenseBashMember[] = [];
		const lastBashStatus = new Map<string, string>();
		const lastBashPolls = new Map<string, Set<string>>();
		const seenBashWarnings = new Set<string>();
		const appendRow = (child: Component): void => {
			const row =
				child instanceof SystemPromptStatus && !grouped
					? null
					: child instanceof ToolExecutionComponent || isDensityCardSource(child)
						? this.densityRowOf(child)
						: null;
			const joins = grouped && previous !== undefined && row !== null;
			previous?.setLayout(grouped, previousFirst, !joins);
			previous = row ?? undefined;
			previousFirst = !joins;
			projected.push(row ?? child);
		};
		let reads: DenseReadMember[] = [];
		const flushReads = (): void => {
			const [first, second] = reads;
			if (!first) return;
			if (second) {
				let run = this.denseReadRuns.get(first.card);
				if (!run) {
					run = new DenseReadRun();
					this.denseReadRuns.set(first.card, run);
				}
				run.setMembers(reads);
				appendRow(run);
			} else {
				appendRow(first.card);
			}
			reads = [];
		};
		const flushPatches = (): void => {
			if (patchRun.length === 0) return;
			const files = patchRun.flatMap((run) => run.files);
			if (files.length >= 3) {
				const first = patchRun[0].owner;
				let group = this.patchDensityGroups.get(first);
				if (!group) {
					group = new PatchDensityCard();
					this.patchDensityGroups.set(first, group);
				}
				group.setGroup(files);
				appendRow(group);
			} else {
				for (const file of files) appendRow(file);
			}
			patchRun = [];
		};
		const flushBash = (): void => {
			const [first] = bashRun;
			if (first) {
				let run = this.denseBashRuns.get(first.card);
				if (!run) {
					run = new DenseBashRun();
					this.denseBashRuns.set(first.card, run);
				}
				run.setMembers(bashRun);
				appendRow(run);
			}
			bashRun = [];
			lastBashPolls.clear();
			seenBashWarnings.clear();
		};
		let ruleNotices: DenseProjectRulesMember[] = [];
		const flushRuleNotices = (): void => {
			const [first, second] = ruleNotices;
			if (!first) return;
			if (second) {
				let run = this.denseProjectRulesRuns.get(first.card);
				if (!run) {
					run = new DenseProjectRulesRun();
					this.denseProjectRulesRuns.set(first.card, run);
				}
				run.setMembers(ruleNotices);
				appendRow(run);
			} else {
				appendRow(first.card);
			}
			ruleNotices = [];
		};
		const models = new DenseWorkerModels();
		const append = (child: Component): void => {
			if (child instanceof ToolExecutionComponent) {
				const { name, details, pending, failed } = child.summarySnapshot;
				child.setDenseEarlierModel(models.forTask(name, details));
				if (!pending && !failed) models.observe(name, details);
			} else if (child instanceof CustomMessageComponent) {
				const sender = child.denseSenderSessionId;
				if (sender) child.setDenseSenderModel(models.forSession(sender));
			}
			if (child instanceof CustomEntryComponent && child.projectRulesNotice) {
				flushBash();
				flushReads();
				flushPatches();
				ruleNotices.push({ card: child, notice: child.projectRulesNotice });
				return;
			}
			flushRuleNotices();
			if (child instanceof TerminalBackgroundNotice) {
				flushReads();
				flushPatches();
				if (seenBashWarnings.has(child.dedupKey)) return;
				seenBashWarnings.add(child.dedupKey);
				bashRun.push({
					kind: "warning",
					card: child,
					sourceRevision: child.getRenderRevision(),
					view: child.renderDensityCard(),
					statusGlyph: "!",
				});
				return;
			}
			if (child instanceof ToolExecutionComponent && child.summarySnapshot.name === "bash_output") {
				flushReads();
				flushPatches();
				const member = denseBashProjection(child);
				if (member) {
					const { poll } = member;
					const state = `${poll.processStatus}\0${poll.exitKey}\0${poll.exitCode ?? ""}`;
					const previous = lastBashStatus.get(poll.sessionId);
					const changed = previous !== state;
					lastBashStatus.set(poll.sessionId, state);
					if (changed) lastBashPolls.delete(poll.sessionId);
					const empty = poll.emptyPlaceholder !== undefined && poll.emptyPlaceholder !== "literal";
					const details = child.presentationSnapshot.state.result?.details;
					const widget = isRecord(details) && isRecord(details.jobWidget) ? details.jobWidget : undefined;
					const hasExtra = widget !== undefined || poll.notices.length > 0 || poll.testLabel !== undefined;
					if (empty && !hasExtra && (poll.status === "running" || !changed)) return;
					// A widget refresh only matters when its presentation changes, not when its clock advances.
					const widgetKey =
						widget === undefined ? undefined : canonicalJson(toStoreValue([widget.state, widget.view]));
					const signature = JSON.stringify([
						state,
						poll.bodyFingerprint,
						poll.notices,
						member.view.heading,
						widgetKey,
					]);
					let seen = lastBashPolls.get(poll.sessionId);
					if (!seen) {
						seen = new Set();
						lastBashPolls.set(poll.sessionId, seen);
					}
					if (seen.has(signature)) return;
					seen.add(signature);
					// A test count names one invocation, not the combined set of bash ids.
					if (poll.testLabel !== undefined) {
						flushBash();
						lastBashPolls.set(poll.sessionId, seen);
						appendRow(child);
					} else {
						bashRun.push(member);
					}
					return;
				}
				flushBash();
				appendRow(child);
				return;
			}
			flushBash();
			if (child instanceof ToolExecutionComponent && child.summarySnapshot.name === "apply_patch") {
				flushReads();
				const patch = this.applyPatchProjectionOf(child);
				if (patch?.status === "done") {
					patchRun.push({ owner: child, files: [...patch.files] });
					return;
				}
				flushPatches();
				if (patch?.status === "failed") {
					appendRow(patch.failure);
					for (const file of patch.files) appendRow(file);
				} else appendRow(child);
				return;
			}
			flushPatches();
			const read = denseReadProjection(child);
			if (read === "hidden") return;
			if (read) {
				if (reads.length > 0 && reads[0].kind !== read.kind) flushReads();
				reads.push(read);
			} else {
				flushReads();
				appendRow(child);
			}
		};
		for (const [index, child] of this.children.entries()) {
			// The density card supplies the outer spacing for a transcript notice.
			if (child instanceof Spacer && this.children[index + 1] instanceof TerminalBackgroundNotice) continue;
			if (
				child instanceof Spacer &&
				(this.children[index + 1] instanceof TranscriptNotice ||
					this.children[index + 1] instanceof CompactionSummaryMessageComponent ||
					(grouped && this.children[index + 1] instanceof SystemPromptStatus))
			) {
				flushBash();
				continue;
			}
			if (child instanceof AssistantMessageComponent) {
				child.setSuppressCompletedThinkingLabel(true);
				if (!child.hasTranscriptRows) continue;
				for (const part of child.getDensityChildren(grouped)) append(part);
			} else {
				append(child);
			}
		}
		flushReads();
		flushPatches();
		flushRuleNotices();
		flushBash();
		previous?.setLayout(grouped, previousFirst, true);
		this.densityProjection = { source: [...this.children], projected, clock: currentRenderRevision() };
		return projected;
	}

	private applyPatchProjectionOf(card: ToolExecutionComponent): ReturnType<PatchDensityProjection["update"]> {
		const snapshot = card.summarySnapshot;
		if (snapshot.pending) return undefined;
		const { identity, state } = card.presentationSnapshot;
		if (!state.result) return undefined;
		const details = applyPatchToolDetails(state.result.details);
		if (!details && !state.result.isError) return undefined;
		const view = patchDensityCard({
			result: { content: state.result.content, details },
			isError: state.result.isError,
			isPartial: state.isPartial,
			executionStarted: state.executionStarted,
			input: normalizeApplyPatchArguments(state.args).input,
			cwd: identity.cwd,
			theme,
		});
		let projection = this.patchDensityProjections.get(card);
		if (!projection) {
			projection = new PatchDensityProjection();
			this.patchDensityProjections.set(card, projection);
		}
		return projection.update(card, view);
	}

	private densityRowOf(card: ToolExecutionComponent | DensityCardSource): ToolDensityRow {
		const cached = this.densityRows.get(card);
		if (cached !== undefined) return cached;
		const row = new ToolDensityRow(card, this.requestRender, () => this.densityColors);
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
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (child instanceof TerminalTestCompletion) continue;
			if (child instanceof Spacer) {
				const notice = this.children[index + 1];
				const nextNotice = this.children[index + 3];
				if (
					isDefaultStatusRow(notice) &&
					this.children[index + 2] instanceof Spacer &&
					isDefaultStatusRow(nextNotice) &&
					(notice instanceof TerminalBackgroundNotice || nextNotice instanceof TerminalBackgroundNotice)
				) {
					// Match the legacy status row replacement only in this projection.
					closeGroup();
					index++; // Skip the older status text with its spacer.
					continue;
				}
			}
			if (child instanceof AssistantMessageComponent) child.setSuppressCompletedThinkingLabel(false);
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
		this.patchDensityProjections = new WeakMap();
		this.patchDensityGroups = new WeakMap();
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

function applyPatchToolDetails(value: unknown): ApplyPatchToolDetails | undefined {
	if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.failures)) return undefined;
	if (value.preview === undefined) return value as ApplyPatchToolDetails;
	if (!isRecord(value.preview) || !Array.isArray(value.preview.files)) return undefined;
	if (!value.preview.files.every(isApplyPatchPreviewFile)) return undefined;
	return value as ApplyPatchToolDetails;
}

function isApplyPatchPreviewFile(value: unknown): value is ApplyPatchPreviewFile {
	return (
		isRecord(value) &&
		typeof value.filePath === "string" &&
		(value.movePath === undefined || typeof value.movePath === "string") &&
		(value.operation === "add" || value.operation === "delete" || value.operation === "update") &&
		typeof value.diff === "string" &&
		(value.binary === undefined || value.binary === true) &&
		(value.patch === undefined || typeof value.patch === "string") &&
		typeof value.added === "number" &&
		typeof value.removed === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
