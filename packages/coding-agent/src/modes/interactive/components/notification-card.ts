import type { DensityCardRenderOptions, DensityCardSource, DensityCardStructuredView } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { TranscriptStatusText } from "./themed-text.ts";

export type NotificationKind = "info" | "warning" | "error" | "tool" | "hot-reload";

type NotificationCardOptions = {
	readonly heading?: string;
	readonly body?: string;
	readonly defaultText?: () => string;
	readonly paddingX?: number;
};

function statusGlyph(kind: NotificationKind): string {
	switch (kind) {
		case "info":
			return "i";
		case "warning":
			return "!";
		case "error":
			return "×";
		case "tool":
			return "›";
		case "hot-reload":
			return "Ⅱ";
		default:
			return assertNever(kind);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unexpected notification kind: ${value}`);
}

function notificationHeading(kind: NotificationKind, message: string, heading?: string): string {
	if (heading !== undefined) return heading;
	if (kind === "hot-reload") return "hot-reload • deferred";
	const detail = message.split(/\r?\n/u, 1)[0] ?? message;
	return `${kind === "info" ? "status" : kind} • ${detail}`;
}

/** A plain transcript notification that becomes a foldable semantic card in dense modes. */
export class NotificationCard extends TranscriptStatusText implements DensityCardSource {
	readonly densityExpanded = false;
	readonly coalescesDefaultStatus: boolean;
	private readonly kind: NotificationKind;
	private readonly heading: string;
	private readonly body: string;

	constructor(kind: NotificationKind, message: string, options: NotificationCardOptions = {}) {
		const color = kind === "error" ? "error" : kind === "warning" ? "warning" : "dim";
		super(options.defaultText ?? (() => theme.fg(color, message)), options.paddingX ?? 1, 0);
		this.kind = kind;
		this.coalescesDefaultStatus = kind === "info" || kind === "hot-reload";
		this.heading = notificationHeading(kind, message, options.heading);
		this.body = options.body ?? message;
	}

	renderDensitySummary(_width: number, _grouped: boolean): string[] {
		return [`${statusGlyph(this.kind)} ${this.heading}`];
	}

	renderDensityCard(_width: number, _options: DensityCardRenderOptions): DensityCardStructuredView {
		return {
			format: "structured",
			kind: this.kind === "tool" ? "tool" : "system",
			heading: { description: this.heading },
			statusGlyph: statusGlyph(this.kind),
			body: [{ type: "text", lines: this.body.split(/\r?\n/u) }],
			sections: [],
		};
	}

	getBackgroundPainter(): undefined {
		return undefined;
	}

	setExpanded(_expanded: boolean): void {}
}
