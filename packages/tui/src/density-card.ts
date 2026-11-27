/** Optional semantic content contract for transcript rows that own their visual framing. */
import type { Component } from "./tui.ts";

export type DensityCardStatus = "pending" | "running" | "queued" | "detached" | "done" | "failed" | "cancelled";

/** Semantic palette role, independent of execution status and the visible name. */
export type DensityCardKind =
	| "eval"
	| "shell"
	| "powershell"
	| "bash-output"
	| "wait"
	| "wake"
	| "loop-guard"
	| "read"
	| "viewed"
	| "todo"
	| "question"
	| "goal"
	| "edit"
	| "write"
	| "added"
	| "edited"
	| "deleted"
	| "patched"
	| "memory"
	| "skill"
	| "rules"
	| "project-rules"
	| "kibitz"
	| "message"
	| "incoming-message"
	| "outgoing-message"
	| "task"
	| "task-peek"
	| "tool"
	| "search"
	| "find"
	| "grep"
	| "ls"
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

export interface DensityCardLegacyView {
	readonly format?: undefined;
	/** Plain lowercase semantic item name, styled by the frame renderer. */
	readonly name?: string;
	readonly kind?: DensityCardKind;
	/** With a name, supply only the detail suffix including its separator. Italic and strike spans are retained. */
	readonly title: string;
	/** Optional expanded title, subject to the same suffix contract. Without a name, both titles are legacy styled text. */
	readonly expandedTitle?: string;
	/** Omit execution status for notices and action-specific rows. */
	readonly status?: DensityCardStatus;
	/** A glyph that replaces the standard execution glyph. The host owns its foreground. */
	readonly statusGlyph?: string;
	/** Additional folded rows, such as a provider's secondary status. */
	readonly foldedDetails?: readonly string[];
	readonly metadata?: string;
	renderMetadata?(width: number): readonly string[];
	renderContent(width: number): readonly string[];
	readonly sections: readonly DensityCardSection[];
}

export interface DensityCardSpan {
	readonly text: string;
	readonly role?: "dim" | "muted" | "text";
	readonly italic?: boolean;
	readonly strikethrough?: boolean;
	readonly link?: string;
}

export type DensityCardText = string | readonly DensityCardSpan[];

export interface DensityCardHeading {
	readonly identity?: string;
	/** Text attached directly to the identity, with no heading separator. */
	readonly identitySuffix?: DensityCardText;
	readonly details?: readonly DensityCardText[];
	readonly description?: string;
}

export type DensityCardBlock =
	| { readonly type: "text"; readonly lines: readonly DensityCardText[]; readonly role?: "muted" | "text" }
	| { readonly type: "rich"; render(width: number, grouped?: boolean): readonly string[] };

export interface DensityCardStructuredSection {
	readonly placement: "frame" | "after" | "grouped";
	readonly heading:
		| { readonly label: string; readonly role?: "title"; readonly bold?: boolean }
		| {
				readonly kind: DensityCardKind;
				readonly heading: DensityCardHeading;
				readonly statusGlyph?: string;
				readonly status?: DensityCardStatus;
		  };
	readonly body: readonly DensityCardBlock[];
}

export interface DensityCardStructuredView {
	readonly format: "structured";
	readonly kind: DensityCardKind;
	readonly heading: DensityCardHeading;
	readonly expandedHeading?: DensityCardHeading;
	readonly statusGlyph?: string;
	readonly status?: DensityCardStatus;
	readonly body: readonly DensityCardBlock[];
	readonly sections: readonly DensityCardStructuredSection[];
	readonly foldedDetails?: readonly string[];
}

export type DensityCardView = DensityCardLegacyView | DensityCardStructuredView;

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
