/** Optional semantic content contract for transcript rows that own their visual framing. */
import type { Component } from "./tui.ts";

export type DensityCardStatus = "pending" | "running" | "queued" | "detached" | "done" | "failed" | "cancelled";

/** Semantic palette role, independent of execution status and the visible name. */
export type DensityCardKind =
	| "eval"
	| "shell"
	| "read"
	| "todo"
	| "goal"
	| "added"
	| "edited"
	| "deleted"
	| "memory"
	| "skill"
	| "rules"
	| "kibitz"
	| "message"
	| "task"
	| "tool"
	| "search"
	| "compaction"
	| "system";

export interface DensityCardSection {
	/** Plain lowercase item name; when present, label is its detail suffix including the separator. */
	readonly name?: string;
	readonly statusGlyph?: string;
	readonly label: string;
	readonly placement: "frame" | "after" | "grouped";
	render(width: number, grouped?: boolean): readonly string[];
}

export interface DensityCardView {
	/** Plain lowercase semantic item name, styled by the frame renderer. */
	readonly name?: string;
	readonly kind?: DensityCardKind;
	/** With a name, supply only the detail suffix including its separator. Italic and strike spans are retained. */
	readonly title: string;
	/** Optional expanded title, subject to the same suffix contract. Without a name, both titles are legacy styled text. */
	readonly expandedTitle?: string;
	/** Omit execution status for notices and action-specific rows. */
	readonly status?: DensityCardStatus;
	/** An already-styled glyph that replaces the standard execution glyph. */
	readonly statusGlyph?: string;
	/** Additional folded rows, such as a provider's secondary status. */
	readonly foldedDetails?: readonly string[];
	readonly metadata?: string;
	renderMetadata?(width: number): readonly string[];
	renderContent(width: number): readonly string[];
	readonly sections: readonly DensityCardSection[];
}

export interface DensityCardRenderOptions {
	readonly grouped: boolean;
	readonly expanded?: boolean;
}

export interface DensityCardSource extends Component {
	renderDensityCard(width: number, options: DensityCardRenderOptions): DensityCardView | undefined;
}

export function isSemanticDensityCardSource(component: Component): component is DensityCardSource {
	return "renderDensityCard" in component && typeof component.renderDensityCard === "function";
}
