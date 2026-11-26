import { type DensityCardStructuredView, nextRenderRevision, sanitizeTerminalLabel } from "@earendil-works/pi-tui";
import type { TerminalBackgroundAgeEvent } from "../../../core/extensions/builtin/monitor-state-event.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { densityCardHeading, densityCardStyle } from "./density-card-style.ts";
import { ThemedText } from "./themed-text.ts";
import type { DensityCardSource } from "./tool-density-row.ts";

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

	constructor(event: TerminalBackgroundAgeEvent, message: string, expanded: boolean) {
		super(
			() => (event.kind === "running" ? theme.fg("dim", message) : theme.fg("warning", `Warning: ${message}`)),
			1,
			0,
		);
		this.sessionId = event.id;
		this.dedupKey = JSON.stringify([event.id, event.startedAtMs, event.kind, event.ageMinutes, message]);
		this.isRunningStatus = event.kind === "running";
		this.expanded = expanded;
		this.view = {
			format: "structured",
			kind: "bash-output",
			heading: { identity: displayBashSessionId(event.id), details: [ageTitle(event)] },
			statusGlyph: "!",
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
		return [`${style.icon("!")} ${densityCardHeading(this.view.kind, this.view.heading, style)}`];
	}

	getBackgroundPainter(): (text: string) => string {
		return (text) => theme.bg("toolSuccessBg", text);
	}
}
