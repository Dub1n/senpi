import {
	Box,
	Container,
	type DensityCardStructuredView,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { sharedMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

const TERMINAL_ESCAPE_SEQUENCE =
	/(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;

function sanitizeCompactionSummary(summary: string): string {
	return summary
		.replace(TERMINAL_ESCAPE_SEQUENCE, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCompactionDetails(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	if (details.schema !== "senpi.compaction.openai-remote.v1") return undefined;
	const retained = typeof details.retainedInputItemCount === "number" ? details.retainedInputItemCount : undefined;
	const requested = typeof details.requestInputItemCount === "number" ? details.requestInputItemCount : undefined;
	const retainedText = retained === undefined ? "native replay active" : `${retained.toLocaleString()} retained items`;
	const requestedText = requested === undefined ? "" : ` from ${requested.toLocaleString()} OpenAI input items`;
	const route =
		details.transport === "websocket" ? "OpenAI Responses WebSocket compaction" : "OpenAI remote compact API";
	return `${route}: ${retainedText}${requestedText}`;
}

/** Session summaries have a pre-compaction count only. Remote usage measures the request, not the retained context. */
function denseRemoteDetails(details: unknown) {
	if (!isRecord(details) || details.schema !== "senpi.compaction.openai-remote.v1") return undefined;
	const count = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined);
	return {
		transport: details.transport,
		requested: count(details.requestInputItemCount),
		retained: count(details.retainedInputItemCount),
	};
}

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = sharedMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	/** Rendered entirely by children that this class rebuilds on every state change. */
	override getRenderRevision(): number | undefined {
		return this.childRenderRevision();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	get densityExpanded(): boolean {
		return this.expanded;
	}

	renderDensitySummary(): string[] {
		return [`compacted${this.densitySuffix()}`];
	}

	getBackgroundPainter(): (text: string) => string {
		return (text) => theme.bg("customMessageBg", text);
	}

	renderDensityCard(_width: number, _options: { readonly grouped: boolean }): DensityCardStructuredView {
		const remote = denseRemoteDetails(this.message.details);
		const details = [`from ${this.message.tokensBefore.toLocaleString()} tokens`];
		if (remote?.retained !== undefined) {
			details.push(`${remote.retained.toLocaleString()} retained item${remote.retained === 1 ? "" : "s"}`);
		}
		return {
			format: "structured",
			kind: "compaction",
			heading: { details },
			status: "done",
			body: [{ type: "rich", render: (width) => this.densityMarkdown().render(width) }],
			sections: [],
		};
	}

	private densityMarkdown(): Markdown {
		const summary = sanitizeCompactionSummary(this.message.summary);
		const remote = denseRemoteDetails(this.message.details);
		let content = summary;
		if (remote) {
			const requested =
				remote.requested === undefined
					? ""
					: ` from ${remote.requested.toLocaleString()} OpenAI input item${remote.requested === 1 ? "" : "s"}`;
			if (
				remote.transport === "responses-v2" &&
				remote.retained === 1 &&
				summary === "OpenAI remote compaction retained 1 native item (responses-v2)."
			) {
				content = `${summary.slice(0, -1)}${requested}.`;
			} else {
				const route =
					remote.transport === "websocket"
						? "OpenAI Responses WebSocket compaction"
						: remote.transport === "responses-v2"
							? "OpenAI remote compaction (responses-v2)"
							: remote.transport === "compact-endpoint"
								? "OpenAI remote compact API"
								: "OpenAI remote compaction";
				const retained =
					remote.retained === undefined
						? ""
						: `: ${remote.retained.toLocaleString()} retained item${remote.retained === 1 ? "" : "s"}`;
				content = [summary, `${route}${retained}${requested}`].filter(Boolean).join("\n\n");
			}
		}
		return new Markdown(content, 0, 0, this.markdownTheme, {
			color: (text: string) => theme.fg("customMessageText", text),
		});
	}

	private expandedMarkdown(): Markdown {
		const details = formatCompactionDetails(this.message.details);
		const detailLine = details ? `\n${details}\n\n` : "\n\n";
		const markdown = `**Compacted from ${this.message.tokensBefore.toLocaleString()} tokens**${detailLine}${sanitizeCompactionSummary(this.message.summary)}`;
		return new Markdown(markdown, 0, 0, this.markdownTheme, {
			color: (text: string) => theme.fg("customMessageText", text),
		});
	}

	private densitySuffix(): string {
		const retained = denseRemoteDetails(this.message.details)?.retained;
		const suffix =
			retained === undefined ? "" : ` · ${retained.toLocaleString()} retained item${retained === 1 ? "" : "s"}`;
		return ` from ${this.message.tokensBefore.toLocaleString()} tokens${suffix}`;
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const details = formatCompactionDetails(this.message.details);
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));

		if (this.expanded) {
			content.addChild(this.expandedMarkdown());
		} else {
			const prefix = details ? `${details}; ` : "";
			content.addChild(
				new Text(
					theme.fg("customMessageText", `${prefix}compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
