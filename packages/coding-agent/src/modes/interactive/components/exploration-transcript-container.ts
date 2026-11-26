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
import {
	type ToolCardFoldDefaults,
	type ToolCardNesting,
	type ToolDisplayColors,
	type ToolDisplayDensity,
	toolCardNestingDefaults,
} from "../../../core/settings-manager.ts";
import { patchDensityCard } from "../../../core/extensions/builtin/gpt-apply-patch/density.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchToolDetails,
} from "../../../core/extensions/builtin/gpt-apply-patch/types.ts";
import { normalizeApplyPatchArguments } from "../../../core/extensions/builtin/gpt-apply-patch/params.ts";
import { AssistantMessageComponent, getAssistantNativeSearchMetadata } from "./assistant-message.ts";
import { PatchDensityCard, PatchDensityProjection } from "./patch-density-projection.ts";
import { CustomEntryComponent } from "./custom-entry.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
import { type DenseProjectRulesMember, DenseProjectRulesRun } from "./dense-project-rules.ts";
import { DensityFolds } from "./density-fold.ts";
import { denseBashProjection, DenseBashRun, type DenseBashMember } from "./dense-bash-run.ts";
import { type DenseReadMember, denseReadProjection, DenseReadRun } from "./dense-read-run.ts";
import { DenseSearchRun } from "./dense-search-run.ts";
import { AssistantDensityCard } from "./assistant-density-card.ts";
import { type ExplorationCall, explorationCall } from "./exploration-call.ts";
import { ExplorationGroup } from "./exploration-group.ts";
import { DenseWorkerModels } from "./omo-task-density.ts";
import { NotificationCard } from "./notification-card.ts";
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
		(child instanceof NotificationCard ? child.coalescesDefaultStatus : child instanceof TranscriptStatusText) ||
		child instanceof SystemPromptStatus ||
		(child instanceof TerminalBackgroundNotice && child.isRunningStatus)
	);
}

type ExplorationTranscriptOptions = ProgressiveTranscriptOptions & {
	readonly onDenseToolOpen?: (card: ToolExecutionComponent) => void;
	readonly needsDenseHandledPress?: () => boolean;
};

/**
 * Original children remain the lifecycle/ID/anchor model. A non-owning projection groups their
 * presentation before progressive hydration, so compact frames never render hidden tool results.
 * Re-projecting also handles partial args, late text, and visibility changes without moving cards.
 */
export class ExplorationTranscriptContainer extends Container {
	private readonly display: ProgressiveTranscriptContainer;
	private readonly requestRender: () => void;
	private readonly options: ExplorationTranscriptOptions;
	private density: ToolDisplayDensity = "default";
	private densitySessionId: string | undefined;
	private densityFolds = new DensityFolds();
	private densityNesting: ToolCardNesting = toolCardNestingDefaults;
	private pressedDensityRow: ToolDensityRow | undefined;
	private densityColors: ToolDisplayColors = { colorFrames: false, colorNames: false, colorIcons: false };
	private readonly densityRows = new WeakMap<ToolExecutionComponent | DensityCardSource, ToolDensityRow>();
	private denseBashRuns = new WeakMap<ToolExecutionComponent | TerminalBackgroundNotice, DenseBashRun>();
	private denseReadRuns = new WeakMap<ToolExecutionComponent, DenseReadRun>();
	private denseSearchRuns = new WeakMap<AssistantDensityCard, DenseSearchRun>();
	private denseProjectRulesRuns = new WeakMap<CustomEntryComponent, DenseProjectRulesRun>();
	private readonly patchDensityProjections = new WeakMap<ToolExecutionComponent, PatchDensityProjection>();
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

	constructor(options: ExplorationTranscriptOptions) {
		super();
		this.display = new ProgressiveTranscriptContainer(options);
		this.requestRender = options.requestRender;
		this.options = options;
	}

	get toolDisplayDensity(): ToolDisplayDensity {
		return this.density;
	}

	/** Select the collapsed transcript presentation. */
	setToolDisplayDensity(density: ToolDisplayDensity): void {
		if (this.density === density) return;
		this.density = density;
		if (density === "default") {
			for (const child of this.children) {
				if (child instanceof ToolExecutionComponent || isDensityCardSource(child))
					child.setDensityDetail?.(undefined);
			}
		}
		this.pressedDensityRow = undefined;
		this.densityProjection = undefined;
		this.display.invalidateCache();
	}

	setDensitySession(sessionId: string): void {
		if (this.densitySessionId === sessionId) return;
		this.densitySessionId = sessionId;
		const defaults = this.densityFolds.defaults;
		this.densityFolds = new DensityFolds();
		this.denseSearchRuns = new WeakMap();
		this.densityFolds.setDefaults(defaults);
	}

	resetDensityFolds(expanded: boolean): void {
		if (this.density !== "default") this.projectDensity();
		this.densityFolds.reset(expanded);
		this.display.invalidateCache();
	}

	setDenseCardPreferences(defaults: ToolCardFoldDefaults, nesting: ToolCardNesting): void {
		if (this.density !== "default") this.projectDensity();
		this.densityFolds.setDefaults(defaults);
		const previous = this.densityNesting;
		if (previous.reads !== nesting.reads) this.denseReadRuns = new WeakMap();
		if (previous.patches !== nesting.patches) this.patchDensityGroups = new WeakMap();
		if (previous.bashOutput !== nesting.bashOutput) this.denseBashRuns = new WeakMap();
		if (previous.projectRules !== nesting.projectRules) this.denseProjectRulesRuns = new WeakMap();
		if (
			previous.reads === nesting.reads &&
			previous.patches === nesting.patches &&
			previous.bashOutput === nesting.bashOutput &&
			previous.projectRules === nesting.projectRules
		)
			return;
		this.densityNesting = nesting;
		this.pressedDensityRow = undefined;
		this.densityProjection = undefined;
		if (this.density !== "default") this.display.invalidateCache();
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
		let searches: AssistantDensityCard[] = [];
		let searchMetadata: NonNullable<ReturnType<typeof getAssistantNativeSearchMetadata>>[] = [];
		let searchSpacers: Component[] = [];
		const flushSearches = (): void => {
			if (searches.length >= 2) {
				let run = this.denseSearchRuns.get(searches[0]);
				if (!run) {
					run = new DenseSearchRun(this.densityFolds.forSource(searches[0], true));
					this.denseSearchRuns.set(searches[0], run);
				}
				run.setMembers(
					searches,
					searchMetadata,
					searches.map((card) => this.densityFolds.forSource(card)),
				);
				appendRow(run);
			} else {
				for (const card of searches) appendRow(card);
			}
			searches = [];
			searchMetadata = [];
			for (const spacer of searchSpacers) appendRow(spacer);
			searchSpacers = [];
		};
		const flushReads = (): void => {
			const [first, second] = reads;
			if (!first) return;
			if (second && this.densityNesting.reads) {
				let run = this.denseReadRuns.get(first.card);
				if (!run) {
					run = new DenseReadRun(
						this.densityFolds.forNest("reads", first.card.toolCallId),
						this.options.onDenseToolOpen,
					);
					this.denseReadRuns.set(first.card, run);
				}
				run.setMembers(
					reads,
					reads.map(({ card }) => this.densityFolds.forTool(card.toolCallId)),
				);
				appendRow(run);
			} else {
				for (const { card } of reads) appendRow(card);
			}
			reads = [];
		};
		const appendPatchGroup = (first: ToolExecutionComponent, files: readonly PatchDensityCard[]): void => {
			let group = this.patchDensityGroups.get(first);
			if (!group) {
				group = new PatchDensityCard(this.densityFolds.forPatch(first.toolCallId, "group"));
				this.patchDensityGroups.set(first, group);
			}
			group.setGroup(files);
			appendRow(group);
		};
		const flushPatches = (): void => {
			if (patchRun.length === 0) return;
			if (this.densityNesting.patches) {
				const files = patchRun.flatMap((run) => run.files);
				if (files.length >= 3) appendPatchGroup(patchRun[0].owner, files);
				else for (const file of files) appendRow(file);
			} else {
				for (const { owner, files } of patchRun) {
					if (files.length > 1) appendPatchGroup(owner, files);
					else for (const file of files) appendRow(file);
				}
			}
			patchRun = [];
		};
		const flushBash = (): void => {
			const [first, second] = bashRun;
			if (first && second && this.densityNesting.bashOutput) {
				let run = this.denseBashRuns.get(first.card);
				if (!run) {
					run = new DenseBashRun(
						first.kind === "poll"
							? this.densityFolds.forNest("bashOutput", first.card.toolCallId)
							: this.densityFolds.forSource(first.card, true),
					);
					this.denseBashRuns.set(first.card, run);
				}
				run.setMembers(
					bashRun,
					bashRun.map(({ card }) => this.densityFoldOf(card)),
				);
				appendRow(run);
			} else {
				for (const { card } of bashRun) appendRow(card);
			}
			bashRun = [];
			lastBashPolls.clear();
			seenBashWarnings.clear();
		};
		let ruleNotices: DenseProjectRulesMember[] = [];
		const flushRuleNotices = (): void => {
			const [first, second] = ruleNotices;
			if (!first) return;
			if (second && this.densityNesting.projectRules) {
				let run = this.denseProjectRulesRuns.get(first.card);
				if (!run) {
					run = new DenseProjectRulesRun(this.densityFolds.forNest("projectRules", first.card.customEntry.id));
					this.denseProjectRulesRuns.set(first.card, run);
				}
				run.setMembers(
					ruleNotices,
					ruleNotices.map(({ card }) => this.densityFoldOf(card)),
				);
				appendRow(run);
			} else {
				for (const { card } of ruleNotices) appendRow(card);
			}
			ruleNotices = [];
		};
		const models = new DenseWorkerModels();
		const append = (child: Component): void => {
			if (child instanceof AssistantDensityCard) {
				const metadata = getAssistantNativeSearchMetadata(child);
				if (metadata) {
					flushBash();
					flushReads();
					flushPatches();
					flushRuleNotices();
					searches.push(child);
					searchMetadata.push(metadata);
					return;
				}
			}
			if (child instanceof Spacer && searches.length > 0) {
				searchSpacers.push(child);
				return;
			}
			flushSearches();
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
				(this.children[index + 1] instanceof NotificationCard ||
					this.children[index + 1] instanceof TranscriptNotice ||
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
		flushSearches();
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
			projection = new PatchDensityProjection(this.densityFolds, card.toolCallId);
			this.patchDensityProjections.set(card, projection);
		}
		return projection.update(card, view);
	}

	private densityRowOf(card: ToolExecutionComponent | DensityCardSource): ToolDensityRow {
		const cached = this.densityRows.get(card);
		if (cached !== undefined) return cached;
		const row = new ToolDensityRow(card, this.requestRender, () => this.densityColors, {
			...(!("densityGroup" in card) && !(card instanceof PatchDensityCard)
				? { fold: this.densityFoldOf(card) }
				: {}),
			onToolOpen: this.options.onDenseToolOpen,
			needsHandledPress: this.options.needsDenseHandledPress,
			onPress: (target) => {
				this.pressedDensityRow = target;
			},
			isClickTarget: (target) => target === this.pressedDensityRow,
		});
		this.densityRows.set(card, row);
		return row;
	}

	private densityFoldOf(card: ToolExecutionComponent | DensityCardSource) {
		if (card instanceof ToolExecutionComponent) return this.densityFolds.forTool(card.toolCallId);
		if (card instanceof CustomEntryComponent) return this.densityFolds.forEntry(card.customEntry.id);
		return this.densityFolds.forSource(card);
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
		if (event.type === "press") this.pressedDensityRow = undefined;
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
		this.pressedDensityRow = undefined;
		this.groups = new WeakMap();
		this.projection = undefined;
		this.densityProjection = undefined;
		super.clear();
	}

	override detachAll(): void {
		this.display.detachAll();
		this.pressedDensityRow = undefined;
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
