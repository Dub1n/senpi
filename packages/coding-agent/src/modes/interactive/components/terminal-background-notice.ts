import { type DensityCardStructuredView, nextRenderRevision, sanitizeTerminalLabel } from "@earendil-works/pi-tui";
import { prefixToolCardTitle } from "../../../core/default-tool-card-title.ts";
import type { TerminalBackgroundAgeEvent } from "../../../core/extensions/builtin/monitor-state-event.ts";
import { type ToolCardIconOverrides, toolCardIconOverride } from "../../../core/tool-card-icons.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import { ThemedText } from "./themed-text.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

const ATTENTION_GLYPH = "!";

export function displayBashSessionId(sessionId: string): string {
	const id = sanitizeTerminalLabel(sessionId);
	const server = /^bash_(\d+)$/u.exec(id);
	if (server) return server[1];
	const child = /^bash_c(\d+)_(\d+)$/u.exec(id);
	return child ? `c${child[1]}/${child[2]}` : id;
}

function ageTitle({ kind, ageMinutes }: TerminalBackgroundAgeEvent): string {
	switch (kind) {
		case "running":
			return `running for ${ageMinutes} minute${ageMinutes === 1 ? "" : "s"}`;
		case "reap_failed":
			return "auto-reap failed";
		case "reaped":
			return "auto-reaped";
		default:
			return assertNever(kind);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unhandled terminal background age notice: ${String(value)}`);
}

/** Display-only terminal age notice. Shell output never goes through this source. */
export class TerminalBackgroundNotice extends ThemedText implements DensityCardSource {
	readonly sessionId: string;
	readonly dedupKey: string;
	readonly isRunningStatus: boolean;
	private readonly view: DensityCardStructuredView;
	private expanded: boolean;
	private densityRevision = nextRenderRevision();
	private defaultIcon: string | undefined;

	constructor(event: TerminalBackgroundAgeEvent, message: string, expanded: boolean) {
		const running = event.kind === "running";
		const title = running ? message : `Warning: ${message}`;
		super(() => theme.fg(running ? "dim" : "warning", prefixToolCardTitle(title, this.defaultIcon)), 1, 0);
		this.sessionId = event.id;
		this.dedupKey = JSON.stringify([event.id, event.startedAtMs, event.kind, event.ageMinutes, message]);
		this.isRunningStatus = running;
		this.expanded = expanded;
		this.view = {
			format: "structured",
			kind: "bash-output",
			heading: { identity: displayBashSessionId(event.id), details: [ageTitle(event)] },
			statusGlyph: ATTENTION_GLYPH,
			body: [
				{
					type: "text",
					lines: stripAnsi(message)
						.replace(/\r\n?/gu, "\n")
						.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
						.split("\n"),
					role: "text",
				},
			],
			sections: [],
		};
	}

	setToolCardIconOverrides(overrides: ToolCardIconOverrides | undefined): void {
		const icon = toolCardIconOverride(overrides, "bash-output", ATTENTION_GLYPH);
		if (icon === this.defaultIcon) return;
		this.defaultIcon = icon;
		this.invalidate();
	}

	get densityExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.densityRevision = nextRenderRevision();
	}

	override getRenderRevision(): number {
		return Math.max(this.densityRevision, super.getRenderRevision());
	}

	renderDensityCard(): DensityCardStructuredView {
		return this.view;
	}

	renderDensitySummary(): string[] {
		const style = densityCardStyle({ colorFrames: false, colorNames: false, colorIcons: false }, this.view.kind);
		return [style.iconPrefix(ATTENTION_GLYPH) + densityCardHeading(this.view.kind, this.view.heading, style)];
	}

	getBackgroundPainter(): (text: string) => string {
		return (text) => theme.bg("toolSuccessBg", text);
	}
}
