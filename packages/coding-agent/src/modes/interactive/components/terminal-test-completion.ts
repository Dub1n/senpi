import { type DensityCardStructuredView, Text } from "@earendil-works/pi-tui";
import { MONITOR_NOTIFICATION_CUSTOM_TYPE } from "../../../core/extensions/builtin/monitor-state-event.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../../core/extensions/builtin/terminal/notify.ts";
import { formatTestSummary, readTestSummary } from "../../../core/extensions/builtin/terminal/tools/test-summary.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { displayBashSessionId } from "./terminal-background-notice.ts";

/** A hidden model notice has a display row only when dense transcript presentation is enabled. */
export class TerminalTestCompletion extends Text {
	densityExpanded: boolean;
	private readonly view: DensityCardStructuredView;

	private constructor(view: DensityCardStructuredView, expanded: boolean) {
		super("", 0, 0);
		this.view = view;
		this.densityExpanded = expanded;
	}

	static from(message: CustomMessage<unknown>, expanded: boolean): TerminalTestCompletion | undefined {
		if (message.display || message.customType !== TERMINAL_NOTIFICATION_CUSTOM_TYPE) return undefined;
		const { details } = message;
		const value: unknown =
			details && typeof details === "object" ? Reflect.get(details, "terminalTestCompletion") : undefined;
		return TerminalTestCompletion.fromDetail(value, message.content, expanded);
	}

	static fromMonitor(message: CustomMessage<unknown>, expanded: boolean): TerminalTestCompletion[] {
		if (message.display || message.customType !== MONITOR_NOTIFICATION_CUSTOM_TYPE) return [];
		const { details } = message;
		const values =
			details && typeof details === "object" ? Reflect.get(details, "terminalTestCompletions") : undefined;
		if (!Array.isArray(values)) return [];
		return values.flatMap((value: unknown) => {
			if (value === null || typeof value !== "object") return [];
			return TerminalTestCompletion.fromDetail(value, Reflect.get(value, "body"), expanded) ?? [];
		});
	}

	private static fromDetail(value: unknown, content: unknown, expanded: boolean): TerminalTestCompletion | undefined {
		if (value === null || typeof value !== "object") return undefined;
		const id: unknown = Reflect.get(value, "id");
		const summary = readTestSummary(Reflect.get(value, "testSummary"));
		if (typeof id !== "string" || !/^bash_(?:c\d+_)?\d+$/.test(id) || summary === undefined) return undefined;
		return new TerminalTestCompletion(
			{
				format: "structured",
				kind: "bash-output",
				heading: {
					identity: displayBashSessionId(id),
					details: [`${summary.runner} run`, formatTestSummary(summary)],
				},
				status: summary.failed > 0 ? "failed" : "done",
				body: typeof content === "string" ? [{ type: "text", lines: content.split("\n") }] : [],
				sections: [],
			},
			expanded,
		);
	}

	setExpanded(expanded: boolean): void {
		if (this.densityExpanded === expanded) return;
		this.densityExpanded = expanded;
		this.invalidate();
	}

	renderDensityCard(): DensityCardStructuredView {
		return this.view;
	}

	renderDensitySummary(): string[] {
		return [];
	}

	getBackgroundPainter(): undefined {
		return undefined;
	}
}
