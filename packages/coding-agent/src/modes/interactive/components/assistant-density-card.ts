import type { ProviderNativeContent } from "@earendil-works/pi-ai";
import { nextRenderRevision, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatProviderNativeBody } from "../../provider-native-rendering.ts";
import { theme } from "../theme/theme.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

export type AssistantDensityCardDescriptor =
	| {
			readonly kind: "provider-native";
			readonly id: string;
			readonly summary: string;
			readonly expandedSummary: string;
			readonly content: ProviderNativeContent;
	  }
	| {
			readonly kind: "handoff";
			readonly id: string;
			readonly block: number;
			readonly summary: string;
			readonly expandedTitle: string;
			readonly body: string;
	  };

/** A lazily expanded assistant detail used by the exploration transcript projection. */
export class AssistantDensityCard implements DensityCardSource {
	private descriptor: AssistantDensityCardDescriptor;
	private readonly onSetExpanded: (expanded: boolean) => void;
	private outputPad: number;
	private isExpanded: boolean;
	private summary: string;
	private expandedSummary: string;
	private expandedTitle: string;
	private handoffBody: string;
	private nativeContent: ProviderNativeContent | undefined;
	private status: string | undefined;
	private nativeBody: Text | undefined;
	private summaryText: Text;
	private expandedSummaryText: Text;
	private handoffText: Text | undefined;
	private revision = nextRenderRevision();

	constructor(
		descriptor: AssistantDensityCardDescriptor,
		outputPad: number,
		expanded: boolean,
		onSetExpanded: (expanded: boolean) => void,
	) {
		this.descriptor = descriptor;
		this.outputPad = outputPad;
		this.isExpanded = expanded;
		this.summary = descriptor.summary;
		this.expandedSummary = descriptor.kind === "provider-native" ? descriptor.expandedSummary : descriptor.summary;
		this.expandedTitle = descriptor.kind === "handoff" ? descriptor.expandedTitle : this.expandedSummary;
		this.handoffBody = descriptor.kind === "handoff" ? descriptor.body : "";
		this.nativeContent = descriptor.kind === "provider-native" ? descriptor.content : undefined;
		this.status = descriptor.kind === "provider-native" ? providerStatus(descriptor.content) : undefined;
		this.onSetExpanded = onSetExpanded;
		this.summaryText = new Text(this.summary, this.outputPad, 0);
		this.expandedSummaryText = new Text(this.expandedSummary, 1, 0);
		if (descriptor.kind === "handoff")
			this.handoffText = new Text(theme.fg("dim", descriptor.body), this.outputPad, 0);
	}

	render(width: number): string[] {
		if (!this.isExpanded) return this.summaryText.render(width);
		if (this.descriptor.kind === "provider-native") {
			this.nativeBody ??= new Text(theme.fg("dim", formatProviderNativeBody(this.descriptor.content, true)), 3, 0);
			return [...this.expandedSummaryText.render(width), ...this.nativeBody.render(width)];
		}
		const title = `${" ".repeat(this.outputPad)}${truncateToWidth(
			this.expandedTitle,
			Math.max(1, width - this.outputPad),
		)}`;
		return [title, ...(this.handoffText?.render(width) ?? [])];
	}

	renderDensitySummary(_width: number, grouped: boolean): string[] {
		return this.descriptor.kind === "provider-native" && !grouped && this.status
			? [this.summary, theme.fg("muted", `status: ${this.status}`)]
			: [this.summary];
	}

	get densityExpanded(): boolean {
		return this.isExpanded;
	}

	getBackgroundPainter(): ((text: string) => string) | undefined {
		return undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this.isExpanded === expanded) return;
		this.isExpanded = expanded;
		this.revision = nextRenderRevision();
		this.onSetExpanded(expanded);
	}

	getRenderRevision(): number {
		return this.revision;
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}

	update(descriptor: AssistantDensityCardDescriptor, outputPad: number, expanded: boolean): void {
		const previous = this.descriptor;
		const contentChanged =
			descriptor.kind !== previous.kind ||
			(descriptor.kind === "provider-native" && descriptor.content !== this.nativeContent);
		const bodyChanged = descriptor.kind === "handoff" && descriptor.body !== this.handoffBody;
		const padChanged = outputPad !== this.outputPad;
		this.descriptor = descriptor;
		this.summary = descriptor.summary;
		this.expandedSummary = descriptor.kind === "provider-native" ? descriptor.expandedSummary : descriptor.summary;
		this.expandedTitle = descriptor.kind === "handoff" ? descriptor.expandedTitle : this.expandedSummary;
		this.handoffBody = descriptor.kind === "handoff" ? descriptor.body : "";
		this.nativeContent = descriptor.kind === "provider-native" ? descriptor.content : undefined;
		this.status = descriptor.kind === "provider-native" ? providerStatus(descriptor.content) : undefined;
		if (contentChanged) this.nativeBody = undefined;
		if (bodyChanged || (descriptor.kind === "handoff" && padChanged)) {
			this.handoffText = new Text(
				theme.fg("dim", descriptor.kind === "handoff" ? descriptor.body : ""),
				outputPad,
				0,
			);
		}
		if (padChanged) {
			this.outputPad = outputPad;
			this.summaryText = new Text(this.summary, outputPad, 0);
		} else {
			this.summaryText.setText(this.summary);
		}
		this.expandedSummaryText.setText(this.expandedSummary);
		if (this.isExpanded !== expanded) this.isExpanded = expanded;
		this.revision = nextRenderRevision();
	}
}

function providerStatus(content: ProviderNativeContent): string | undefined {
	const raw = content.raw;
	return typeof raw === "object" && raw !== null && "status" in raw && typeof raw.status === "string"
		? raw.status
		: undefined;
}
