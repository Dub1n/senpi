import { type DensityCardStructuredView, sanitizeTerminalLabel, Text } from "@earendil-works/pi-tui";
import { defaultToolCardTitle } from "../../../default-tool-card-title.ts";
import { toolResultUserWords } from "../../../tool-result-user-words.ts";
import type { ToolDefinition } from "../../types.ts";
import { TOOL_NAMES } from "./family.ts";
import { resolveUserWordReferences } from "./user-words.ts";

export const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme, context) => {
	const values = typeof args === "object" && args !== null ? args : {};
	const headers =
		"questions" in values && Array.isArray(values.questions)
			? values.questions
					.map((q: unknown) =>
						typeof q === "object" && q !== null && "header" in q ? `[${q.header}]` : "[Question]",
					)
					.join(" ")
			: "Question";
	const wait =
		("waitForAnswer" in values && values.waitForAnswer === true) ||
		("wait_for_answer" in values && values.wait_for_answer === true);
	const title = defaultToolCardTitle(headers, context, (details) => ({
		kind: "question",
		glyph: questionGlyph(details, context?.isError ?? false),
		status: "done",
	}));
	return new Text(`${theme.fg("toolTitle", title)} ${wait ? "wait for answer" : "answer later"}`, 0, 0);
};
export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result) => {
	const details: unknown = result.details;
	let summary = "";
	const words = toolResultUserWords({ details });
	if (typeof details === "object" && details !== null && "status" in details) {
		summary = String(details.status);
		if ("answers" in details && typeof details.answers === "object" && details.answers !== null)
			summary += `; ${Object.keys(details.answers).length} answered`;
		if ("unanswered" in details && Array.isArray(details.unanswered))
			summary += `; ${details.unanswered.length} unanswered`;
	}
	return new Text(
		[summary, ...result.content.flatMap((c) => (c.type === "text" ? [resolveUserWordReferences(c.text, words)] : []))]
			.filter(Boolean)
			.join("\n"),
		0,
		0,
	);
};

function questionGlyph(details: unknown, isError: boolean): string {
	const status = details && typeof details === "object" && "status" in details ? details.status : undefined;
	return isError ? "✗" : status === "cancelled" ? "×" : "?";
}

/** Frame both stock question tools in dense mode. */
export function questionDensityCard(
	name: string,
	result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0] | undefined,
	isError: boolean,
	expanded: boolean,
): DensityCardStructuredView | undefined {
	if (name !== TOOL_NAMES.codex && name !== TOOL_NAMES.claude) return undefined;
	const details: unknown = result?.details;
	const rawStatus = details && typeof details === "object" && "status" in details ? details.status : undefined;
	const status = isError
		? "failed"
		: typeof rawStatus === "string" && rawStatus
			? sanitizeTerminalLabel(rawStatus.replace(/[-_]/gu, " "))
			: result
				? "done"
				: "pending";
	const words = expanded && result ? toolResultUserWords(result) : [];
	const lines =
		expanded && result
			? result.content.flatMap((part) =>
					part.type === "text" ? resolveUserWordReferences(part.text, words).split("\n") : [],
				)
			: [];
	return {
		format: "structured",
		kind: "question",
		heading: { details: [status] },
		statusGlyph: isError ? "✗" : status === "cancelled" ? "×" : "?",
		body: lines.length > 0 ? [{ type: "text", lines }] : [],
		sections: [],
	};
}

/**
 * Renderers for a question card whose tool definition is not resolvable: the tools are registered
 * when the session synchronizes them, so a card streamed while a reload is in flight - or replayed
 * in a session where ask-user is disabled - would otherwise fall back to a raw argument dump.
 */
export function askUserRenderers(toolName: string): Pick<ToolDefinition, "renderCall" | "renderResult"> | undefined {
	return Object.values(TOOL_NAMES).includes(toolName) ? { renderCall, renderResult } : undefined;
}
