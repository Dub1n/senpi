/**
 * Visual contract for a transcript notice box: the shared widget used by
 * loop-guard detections, ttsr stream-rule interventions, goal cache-warm
 * entries, and interactive fallback transitions.
 */
import type { DensityCardStructuredView } from "@earendil-works/pi-tui";

export type NoticeTone = "accent" | "warning" | "error" | "success" | "dim";

export interface NoticeLine {
	readonly text: string;
	/** Line tone; defaults to "dim". */
	readonly tone?: NoticeTone;
}

export interface NoticeSpec {
	/** Optional structured view exposed to density-card consumers. */
	readonly densityCard?: Omit<DensityCardStructuredView, "format" | "body" | "sections">;
	/** Default title's original glyph, when the producer keeps it separate from `title`. */
	readonly defaultIconGlyph?: string;
	readonly title: string;
	/** Title tone; defaults to "accent". */
	readonly tone?: NoticeTone;
	/** Secondary line explaining what happened, rendered dim. */
	readonly why: string;
	/** Optional extra lines between the why line and the expanded detail. */
	readonly extra?: readonly NoticeLine[];
	/** Detail line shown only when the transcript is expanded. */
	readonly expandedLine?: string;
}
