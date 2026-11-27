import { type DensityCardKind, type DensityCardStatus, type DensityCardStructuredView } from "@earendil-works/pi-tui";
import { denseBashPoll } from "../../../core/extensions/builtin/terminal/tools/render.ts";
import type { DenseBashPollView } from "../../../core/extensions/builtin/terminal/tools/render.ts";
import { displayBashSessionId, TerminalBackgroundNotice } from "./terminal-background-notice.ts";
import { TerminalTestCompletion } from "./terminal-test-completion.ts";
import { toolDensityKind, toolDensitySummary } from "./tool-density-summary.ts";
import { createToolResultFallback } from "./tool-execution-fallback.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

interface DenseBashPollMember {
	readonly kind: "poll";
	readonly card: ToolExecutionComponent;
	readonly sourceRevision: number | undefined;
	readonly poll: DenseBashPollView;
	readonly view: DensityCardStructuredView;
	readonly status: DensityCardStatus | undefined;
	readonly statusGlyph: string | undefined;
}

interface DenseBashViewMember {
	readonly kind: "view";
	readonly card: ToolExecutionComponent | TerminalBackgroundNotice | TerminalTestCompletion;
	readonly sourceRevision: number | undefined;
	readonly view: DensityCardStructuredView;
	readonly status: DensityCardStatus | undefined;
	readonly statusGlyph: string | undefined;
	readonly outcome?: {
		readonly sessionId: string;
		readonly processStatus: string;
		readonly exitCode: number | null;
	};
	readonly testCounts?: boolean;
}

export type DenseBashMember = DenseBashPollMember | DenseBashViewMember;

function summaryView(card: ToolExecutionComponent, kind: DensityCardKind): DensityCardStructuredView {
	const snapshot = card.summarySnapshot;
	const summary = toolDensitySummary(snapshot);
	const state = card.presentationSnapshot.state;
	const sessionId = sessionIdOf(card);
	const details = [summary.detail, ...(summary.attention ? [summary.attention] : [])].filter(Boolean);
	let fallback: ReturnType<typeof createToolResultFallback>;
	let fallbackResolved = false;
	return {
		format: "structured",
		kind,
		heading: {
			...(sessionId ? { identity: displayBashSessionId(sessionId) } : {}),
			...(details.length > 0 ? { details } : {}),
		},
		status: summary.status,
		body: [
			{
				type: "rich",
				render: (width) => {
					if (!fallbackResolved) {
						fallback = createToolResultFallback(state.result, state.showImages);
						fallbackResolved = true;
					}
					return fallback?.render(width) ?? [];
				},
			},
		],
		sections: [],
	};
}

function storedBashOutcome(card: ToolExecutionComponent):
	| {
			readonly sessionId: string;
			readonly processStatus: string;
			readonly exitCode: number | null;
	  }
	| undefined {
	const result = card.presentationSnapshot.state.result;
	if (result?.isError === true) return undefined;
	const details = result?.details;
	const value = details !== null && typeof details === "object" ? Reflect.get(details, "bashOutput") : undefined;
	const sessionId = value !== null && typeof value === "object" ? Reflect.get(value, "sessionId") : undefined;
	const processStatus = value !== null && typeof value === "object" ? Reflect.get(value, "processStatus") : undefined;
	const statusStart = value !== null && typeof value === "object" ? Reflect.get(value, "statusStart") : undefined;
	const statusEnd = value !== null && typeof value === "object" ? Reflect.get(value, "statusEnd") : undefined;
	if (
		typeof sessionId !== "string" ||
		typeof processStatus !== "string" ||
		typeof statusStart !== "number" ||
		typeof statusEnd !== "number" ||
		!Number.isSafeInteger(statusStart) ||
		!Number.isSafeInteger(statusEnd) ||
		statusStart < 0 ||
		statusEnd <= statusStart
	)
		return undefined;
	const exitCode: unknown = Reflect.get(value, "exitCode");
	if (exitCode !== null && typeof exitCode !== "number") return undefined;
	return { sessionId, processStatus, exitCode };
}

function sessionIdOf(
	card: ToolExecutionComponent | TerminalBackgroundNotice | TerminalTestCompletion,
): string | undefined {
	if (card instanceof TerminalBackgroundNotice) return card.sessionId;
	if (card instanceof TerminalTestCompletion) return card.renderDensityCard().heading.identity;
	const { args, details } = card.summarySnapshot;
	const argumentId =
		args !== null && typeof args === "object" && !Array.isArray(args) ? Reflect.get(args, "bash_id") : undefined;
	const output = details !== null && typeof details === "object" ? Reflect.get(details, "bashOutput") : undefined;
	const detailId = output !== null && typeof output === "object" ? Reflect.get(output, "sessionId") : undefined;
	return typeof detailId === "string" ? detailId : typeof argumentId === "string" ? argumentId : undefined;
}

function legacyView(
	view: Exclude<ReturnType<ToolExecutionComponent["renderDensityCard"]>, { format: "structured" } | undefined>,
	kind: DensityCardKind,
): DensityCardStructuredView {
	return {
		format: "structured",
		kind: view.kind ?? kind,
		heading: view.name
			? { identity: view.name, details: view.title ? [view.title] : [] }
			: { description: view.title },
		...(view.expandedTitle === undefined
			? {}
			: {
					expandedHeading: view.name
						? { identity: view.name, details: [view.expandedTitle] }
						: { description: view.expandedTitle },
				}),
		status: view.status,
		statusGlyph: view.statusGlyph,
		body: [
			{
				type: "rich",
				render: (width, _grouped) => [
					...(view.metadata ? [view.metadata] : []),
					...(view.renderMetadata?.(width) ?? []),
					...view.renderContent(width),
				],
			},
		],
		sections: view.sections.map((section) => ({
			placement: section.placement,
			heading: section.name
				? {
						kind: view.kind ?? kind,
						heading: { identity: section.name, identitySuffix: section.label },
						...(section.statusGlyph === undefined ? {} : { statusGlyph: section.statusGlyph }),
					}
				: { label: section.label },
			body: [{ type: "rich" as const, render: (width, grouped) => section.render(width, grouped) }],
		})),
		foldedDetails: view.foldedDetails,
	};
}

/** Classify visible Bash cards, using poll metadata only for poll-specific filtering. */
export function denseBashProjection(
	card: ToolExecutionComponent | TerminalBackgroundNotice | TerminalTestCompletion,
): DenseBashMember | undefined {
	if (card instanceof TerminalTestCompletion) {
		const view = card.renderDensityCard();
		return {
			kind: "view",
			card,
			sourceRevision: card.getRenderRevision(),
			view,
			status: view.status,
			statusGlyph: view.statusGlyph,
			testCounts: true,
		};
	}
	if (card instanceof TerminalBackgroundNotice) {
		const view = card.renderDensityCard();
		return {
			kind: "view",
			card,
			sourceRevision: card.getRenderRevision(),
			view,
			status: undefined,
			statusGlyph: view.statusGlyph,
		};
	}
	const snapshot = card.summarySnapshot;
	const kind = toolDensityKind(snapshot.name);
	if (kind !== "shell" && kind !== "bash-output") return undefined;
	const { state } = card.presentationSnapshot;
	const args: { bash_id?: string; view?: "log" | "screen"; filter?: string } = {};
	const rawArgs = snapshot.args;
	if (rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
		const bashId: unknown = Reflect.get(rawArgs, "bash_id");
		const view: unknown = Reflect.get(rawArgs, "view");
		const filter: unknown = Reflect.get(rawArgs, "filter");
		if (typeof bashId === "string") args.bash_id = bashId;
		if (view === "log" || view === "screen") args.view = view;
		if (typeof filter === "string") args.filter = filter;
	}
	const poll = snapshot.name === "bash_output" && state.result ? denseBashPoll(state.result, args) : undefined;
	const view = card.renderDensityCard(120, { grouped: false, expanded: true });
	if (poll && view?.format === "structured") {
		return {
			kind: "poll",
			card,
			sourceRevision: card.getRenderRevision(),
			poll,
			view,
			status: poll.status === "cancelled" ? undefined : poll.status,
			statusGlyph: view.statusGlyph,
		};
	}
	const structured = view?.format === "structured" ? view : view ? legacyView(view, kind) : summaryView(card, kind);
	return {
		kind: "view",
		card,
		sourceRevision: card.getRenderRevision(),
		view: structured,
		status: structured.status,
		statusGlyph: structured.statusGlyph,
		outcome: storedBashOutcome(card),
		testCounts:
			snapshot.details !== null &&
			typeof snapshot.details === "object" &&
			Reflect.get(snapshot.details, "testSummary") !== undefined,
	};
}

export function denseBashMemberSessionId(member: DenseBashMember): string | undefined {
	return member.kind === "poll" ? member.poll.sessionId : sessionIdOf(member.card);
}
