import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	copyLineSources,
	Markdown,
	type MarkdownTheme,
	nextRenderRevision,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { sharedMarkdownTheme, theme } from "../theme/theme.ts";
import { type AssistantRenderDescriptor, createAssistantRenderDescriptors } from "./assistant-render-descriptors.ts";
import { AssistantDensityCard } from "./assistant-density-card.ts";
import type { AssistantDensityCardDescriptor } from "./assistant-density-card.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { createBoundedRenderSignature } from "./render-signature.ts";
import {
	type ProviderNativeWebSearchDetails,
	getProviderNativeWebSearchDetails,
	providerNativeWebSearchQueries,
} from "../../provider-native-rendering.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function assertNever(value: never): never {
	throw new TypeError(`Unexpected assistant render variant: ${String(value)}`);
}

/** The folded handoff line: always one row, cut to the width instead of wrapping (senpi#3323). */
class SingleLine implements Component {
	private readonly revision = nextRenderRevision();
	private readonly text: string;
	private readonly pad: number;
	constructor(text: string, pad: number) {
		this.text = text;
		this.pad = pad;
	}
	render(width: number): string[] {
		const room = Math.max(1, width - this.pad);
		return [`${" ".repeat(this.pad)}${truncateToWidth(this.text, room)}`];
	}
	invalidate(): void {}
	getRenderRevision(): number {
		return this.revision;
	}
}

export interface AssistantNativeSearchMetadata {
	readonly details: ProviderNativeWebSearchDetails;
	readonly queries: readonly string[];
	readonly sourceCount: number;
}

const assistantNativeSearchMetadata = new WeakMap<AssistantDensityCard, AssistantNativeSearchMetadata>();

export function getAssistantNativeSearchMetadata(
	card: AssistantDensityCard,
): AssistantNativeSearchMetadata | undefined {
	return assistantNativeSearchMetadata.get(card);
}

export class AssistantMessageComponent extends Container {
	private renderCache?: { readonly lines: string[]; readonly signature: string; readonly width: number };
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private suppressCompletedThinkingLabel = false;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private lastMessageSignature?: string;
	private renderDescriptors: readonly AssistantRenderDescriptor[] = [];
	private readonly densityCards = new Map<string, AssistantDensityCard>();
	private readonly densityCardExpandedOverrides = new Map<string, boolean>();
	private densityProjection:
		| { readonly revision: number; readonly grouped: boolean; readonly children: readonly Component[] }
		| undefined;
	private readonly densitySelfChildren: readonly Component[];
	private hasToolCalls = false;
	private expanded = false;
	private providerErrorOwned = false;
	private ownsTurnNotice = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private handoffOpenOverrides = new Map<number, boolean>();
	/** Moves whenever the cached render is dropped; output is a function of the state `updateContent` records. */
	private revision = nextRenderRevision();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = sharedMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.densitySelfChildren = [this];

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) this.updateContent(message);
	}

	override invalidate(): void {
		this.renderCache = undefined;
		this.revision = nextRenderRevision();
		super.invalidate();
		this.renderDescriptors = [];
		this.refreshContent();
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinkingBlock === hide) return;
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		this.refreshContent();
	}

	setSuppressCompletedThinkingLabel(suppress: boolean): void {
		if (this.suppressCompletedThinkingLabel === suppress) return;
		this.suppressCompletedThinkingLabel = suppress;
		this.refreshContent();
	}

	setHiddenThinkingLabel(label: string): void {
		if (this.hiddenThinkingLabel === label) return;
		this.hiddenThinkingLabel = label;
		this.refreshContent();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.handoffOpenOverrides.clear();
		this.densityCardExpandedOverrides.clear();
		this.refreshContent();
	}

	/** A replayed turn draws in one component, so it shows its own turn-ending notice (senpi#4958). */
	setOwnsTurnNotice(owned: boolean): void {
		if (this.ownsTurnNotice === owned) return;
		this.ownsTurnNotice = owned;
		this.refreshContent();
	}

	setProviderErrorOwned(owned: boolean): void {
		if (this.providerErrorOwned === owned) return;
		this.providerErrorOwned = owned;
		this.refreshContent();
	}

	/** Transcript-only reasoning/empty streaming heads may sit inside a compact exploration group. */
	get isExplorationDetail(): boolean {
		return this.renderDescriptors.every((part) => part.kind === "spacer" || part.kind === "thinking-label");
	}

	/** Tool-only turns contribute no assistant rows to the transcript. */
	get hasTranscriptRows(): boolean {
		return this.renderDescriptors.length > 0;
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.renderDescriptors = [];
		this.densityProjection = undefined;
		this.refreshContent();
	}

	override getRenderRevision(): number {
		return this.revision;
	}

	/** Return the assistant's stable prose and foldable-card projection for a dense transcript. */
	getDensityChildren(grouped: boolean): readonly Component[] {
		const cached = this.densityProjection;
		if (cached?.revision === this.revision && cached.grouped === grouped) return cached.children;
		const hasDensityCard = this.renderDescriptors.some(
			(descriptor) => descriptor.densityCard && (grouped || descriptor.densityCard.kind !== "handoff"),
		);
		if (!hasDensityCard) {
			this.densityCards.clear();
			this.densityCardExpandedOverrides.clear();
			return this.densitySelfChildren;
		}

		const projected: Component[] = [];
		const activeCards = new Set<string>();
		const emptySearchIds = new Set<string>();
		const nativeSearchById = new Map<string, AssistantNativeSearchMetadata>();
		for (const descriptor of this.renderDescriptors) {
			const cardDescriptor = descriptor.densityCard;
			if (cardDescriptor?.kind !== "provider-native" || cardDescriptor.content.subtype !== "web_search_call")
				continue;
			const details = getProviderNativeWebSearchDetails(cardDescriptor.content.raw);
			if (!details) continue;
			const metadata = {
				details,
				queries: providerNativeWebSearchQueries(details),
				sourceCount: details.sources.length,
			};
			nativeSearchById.set(cardDescriptor.id, metadata);
			if (details.status === "completed" && metadata.queries.length === 0 && metadata.sourceCount === 0)
				emptySearchIds.add(cardDescriptor.id);
		}
		for (let index = 0; index < this.renderDescriptors.length; index++) {
			const descriptor = this.renderDescriptors[index];
			const child = this.contentContainer.children[index];
			if (!descriptor || !child) continue;
			const cardDescriptor = descriptor.densityCard;
			if (cardDescriptor) {
				if (cardDescriptor.kind === "handoff" && !grouped) {
					projected.push(child);
					continue;
				}
				if (emptySearchIds.has(cardDescriptor.id)) continue;
				activeCards.add(cardDescriptor.id);
				const expanded =
					this.densityCardExpandedOverrides.get(cardDescriptor.id) ??
					(cardDescriptor.kind === "handoff"
						? (this.handoffOpenOverrides.get(cardDescriptor.block) ?? this.expanded)
						: this.expanded);
				let card = this.densityCards.get(cardDescriptor.id);
				if (card) {
					card.update(cardDescriptor, this.outputPad, expanded);
				} else {
					card = new AssistantDensityCard(cardDescriptor, this.outputPad, expanded, (nextExpanded) =>
						this.setDensityCardExpanded(cardDescriptor, nextExpanded),
					);
					this.densityCards.set(cardDescriptor.id, card);
				}
				const nativeSearch = nativeSearchById.get(cardDescriptor.id);
				if (nativeSearch) assistantNativeSearchMetadata.set(card, nativeSearch);
				else assistantNativeSearchMetadata.delete(card);
				projected.push(card);
				continue;
			}
			if (descriptor.kind === "provider-native-body" || (grouped && descriptor.kind === "handoff-body")) {
				continue;
			}
			if (
				grouped &&
				descriptor.kind === "spacer" &&
				this.renderDescriptors[index + 1]?.densityCard &&
				(index === 0 || projected.at(-1) instanceof AssistantDensityCard)
			) {
				continue;
			}
			projected.push(child);
		}
		for (const id of this.densityCards.keys()) {
			if (!activeCards.has(id)) this.densityCards.delete(id);
		}
		if (emptySearchIds.size > 0) {
			let previousWasSpacer = true;
			const normalized: Component[] = [];
			for (const child of projected) {
				if (child instanceof Spacer) {
					if (!previousWasSpacer) normalized.push(child);
					previousWasSpacer = true;
				} else {
					normalized.push(child);
					previousWasSpacer = false;
				}
			}
			if (normalized.at(-1) instanceof Spacer) normalized.pop();
			projected.splice(0, projected.length, ...normalized);
		}
		this.densityProjection = { revision: this.revision, grouped, children: projected };
		return projected;
	}

	override render(width: number): string[] {
		const signature = this.lastMessageSignature ?? "";
		if (this.renderCache?.width === width && this.renderCache.signature === signature) {
			return copyLineSources(this.renderCache.lines, [...this.renderCache.lines]);
		}

		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			this.cacheRender(width, signature, lines);
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.cacheRender(width, signature, lines);
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const previousMessage = this.lastMessage;
		const streamingChanged = this.isStreaming !== isStreaming;
		this.isStreaming = isStreaming;
		this.lastMessage = message;
		const messageSignature = this.createMessageSignature(message);
		if (!streamingChanged && previousMessage === message && this.lastMessageSignature === messageSignature) {
			return;
		}
		this.lastMessageSignature = messageSignature;
		this.renderCache = undefined;
		this.densityProjection = undefined;
		this.revision = nextRenderRevision();
		if (streamingChanged) this.renderDescriptors = [];
		this.hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const descriptors = createAssistantRenderDescriptors(message, {
			expanded: this.expanded,
			providerErrorOwned: this.providerErrorOwned,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			hideThinkingBlock: this.hideThinkingBlock,
			suppressCompletedThinkingLabel: this.suppressCompletedThinkingLabel,
			thinkingVisibilityOverrides: this.thinkingVisibilityOverrides,
			handoffOpenOverrides: this.handoffOpenOverrides,
			hasToolCalls: this.hasToolCalls,
			ownsTurnNotice: this.ownsTurnNotice,
		});
		this.reconcileRenderDescriptors(descriptors);
	}

	private reconcileRenderDescriptors(descriptors: readonly AssistantRenderDescriptor[]): void {
		let divergentIndex = 0;
		const sharedLength = Math.min(this.renderDescriptors.length, descriptors.length);
		while (divergentIndex < sharedLength) {
			const previous = this.renderDescriptors[divergentIndex];
			const next = descriptors[divergentIndex];
			const child = this.contentContainer.children[divergentIndex];
			if (!previous || !next || !child || previous.kind !== next.kind) break;
			if (previous.text !== next.text) {
				if ((next.kind === "text-md" || next.kind === "thinking-md") && child instanceof Markdown) {
					child.setText(next.text);
				} else break;
			}
			divergentIndex++;
		}
		for (const child of this.contentContainer.children.splice(divergentIndex)) child.dispose?.();
		for (const descriptor of descriptors.slice(divergentIndex))
			this.contentContainer.addChild(this.createRenderChild(descriptor));
		this.renderDescriptors = descriptors;
	}

	private createRenderChild(descriptor: AssistantRenderDescriptor): Component {
		switch (descriptor.kind) {
			case "spacer":
				return new Spacer(1);
			case "text-md":
				return new Markdown(descriptor.text, this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
				});
			case "thinking-md":
				return this.withThinkingToggle(
					new Markdown(
						descriptor.text,
						this.outputPad,
						0,
						this.markdownTheme,
						{
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						},
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
							),
						},
					),
					descriptor,
				);
			case "thinking-label":
				return this.withThinkingToggle(new Text(descriptor.text, this.outputPad, 0), descriptor);
			case "error-text":
				return new Text(descriptor.text, this.outputPad, 0);
			case "provider-native-summary":
				return new Text(descriptor.text, 1, 0);
			case "provider-native-body":
				return new Text(descriptor.text, 3, 0);
			case "handoff-line":
				return this.withHandoffToggle(new SingleLine(descriptor.text, this.outputPad), descriptor);
			case "handoff-body":
				return this.withHandoffToggle(new Text(descriptor.text, this.outputPad, 0), descriptor);
			default:
				return assertNever(descriptor.kind);
		}
	}

	/**
	 * Left-clicking a thinking run toggles that run between its label and its body (upstream
	 * 71026970a). The mouse handler is attached to the Markdown/Text child itself so the
	 * incremental reconciler still sees the same child types it updates in place.
	 */
	private withThinkingToggle(component: Component, descriptor: AssistantRenderDescriptor): Component {
		const runIndex = descriptor.thinkingRun;
		if (runIndex === undefined) return component;
		component.handleMouse = (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
			this.thinkingVisibilityOverrides.set(runIndex, !hidden);
			this.refreshContent();
			return { handled: true };
		};
		return component;
	}

	/** Left-clicking a handoff fold line or its open body toggles that block, like a thinking run. */
	private withHandoffToggle(component: Component, descriptor: AssistantRenderDescriptor): Component {
		const block = descriptor.handoffBlock;
		if (block === undefined) return component;
		component.handleMouse = (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const open = this.handoffOpenOverrides.get(block) ?? this.expanded;
			this.handoffOpenOverrides.set(block, !open);
			this.refreshContent();
			return { handled: true };
		};
		return component;
	}

	private createMessageSignature(message: AssistantMessage): string {
		return createBoundedRenderSignature({
			content: message.content,
			hiddenThinkingLabel: this.hiddenThinkingLabel,
			hideThinkingBlock: this.hideThinkingBlock,
			thinkingVisibilityOverrides: [...this.thinkingVisibilityOverrides],
			handoffOpenOverrides: [...this.handoffOpenOverrides],
			expanded: this.expanded,
			errorState: [message.diagnostics, message.errorMessage],
			stopReason: message.stopReason,
		});
	}

	private cacheRender(width: number, signature: string, lines: string[]): void {
		this.renderCache = { lines: copyLineSources(lines, [...lines]), signature, width };
	}

	private refreshContent(): void {
		if (!this.lastMessage) return;
		this.lastMessageSignature = undefined;
		this.updateContent(this.lastMessage);
	}

	private setDensityCardExpanded(descriptor: AssistantDensityCardDescriptor, expanded: boolean): void {
		this.densityCardExpandedOverrides.set(descriptor.id, expanded);
		if (descriptor.kind === "handoff") this.handoffOpenOverrides.set(descriptor.block, expanded);
		this.refreshContent();
	}
}
