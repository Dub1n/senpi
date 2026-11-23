// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import {
	type DensityCardSource,
	type DensityCardStructuredView,
	type DensityCardText,
	Text,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "../../../types.ts";
import { fuzzyResolveTask } from "../fuzzy-match.ts";
import { sanitizeTodoText } from "../todo-format.ts";
import type { TodoToolDetails } from "../todo-types.ts";
import { renderTodoPhases } from "./todo-checklist.ts";
import type { TodoParams } from "./todo.ts";

function countInitItems(params: TodoParams): { phases: number; tasks: number } {
	if (params.list) {
		return {
			phases: params.list.length,
			tasks: params.list.reduce((total, phase) => total + phase.items.length, 0),
		};
	}
	if (params.items) return { phases: params.items.length > 0 ? 1 : 0, tasks: params.items.length };
	return { phases: 0, tasks: 0 };
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function renderCallLabel(params: TodoParams): string {
	switch (params.op) {
		case "init": {
			const counts = countInitItems(params);
			return `todo init (${countLabel(counts.phases, "phase")}, ${countLabel(counts.tasks, "task")})`;
		}
		case "append":
			return `todo append: ${sanitizeTodoText(params.phase ?? "") || "(missing phase)"} (${countLabel(
				params.items?.length ?? 0,
				"item",
			)})`;
		case "start":
		case "done":
		case "drop":
			return `todo ${params.op}: ${sanitizeTodoText(params.task ?? params.phase ?? "") || "(missing target)"}`;
		case "rm":
			return `todo rm: ${sanitizeTodoText(params.task ?? params.phase ?? "all") || "all"}`;
		case "view":
			return "todo view";
		// Normalization can rescue a call that omitted `op`; label it generically until
		// execute resolves the effective operation. Listing `undefined` explicitly (instead
		// of `default`) keeps this switch exhaustive, so a new TodoOperation fails typecheck.
		case undefined:
			return "todo";
	}
}

function getTextContent(result: AgentToolResult<TodoToolDetails>): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

type TodoRenderContext = ToolRenderContext<unknown, TodoParams>;
type TodoRenderState = {
	readonly context: TodoRenderContext;
	readonly result?: AgentToolResult<TodoToolDetails>;
	readonly options?: ToolRenderResultOptions;
};

export function renderTodoCall(args: TodoParams, theme: Theme, context: TodoRenderContext): DensityCardSource {
	return new TodoCard(theme, { context }, () => theme.fg("toolTitle", theme.bold(renderCallLabel(args))));
}

export function renderTodoResult(
	result: AgentToolResult<TodoToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: TodoRenderContext,
): DensityCardSource {
	const state = { context, result, options };
	return new TodoCard(theme, state, () => {
		if (context.isError) return theme.fg("toolOutput", getTextContent(result));
		const checklist = renderChecklist(state, theme);
		if (!checklist) return getTextContent(result) || "Todo list is empty.";
		const ask = result.details?.ask;
		return ask ? `${theme.fg("dim", `Ask: ${ask.text}`)}\n${checklist}` : checklist;
	});
}

function renderChecklist({ context, result, options }: TodoRenderState, theme: Theme): string {
	if (!options || !result) return "";
	return renderTodoPhases(
		result.details,
		{ expanded: options.expanded, target: context.args, frame: context.spinnerFrame },
		theme,
	);
}

class TodoCard extends Text implements DensityCardSource {
	private readonly theme: Theme;
	private readonly state: TodoRenderState;
	private readonly defaultText: () => string;
	private defaultReady = false;

	constructor(theme: Theme, state: TodoRenderState, defaultText: () => string) {
		super("", 0, 0);
		this.theme = theme;
		this.state = state;
		this.defaultText = defaultText;
	}

	override render(width: number): string[] {
		if (!this.defaultReady) {
			this.setText(this.defaultText());
			this.defaultReady = true;
		}
		return super.render(width);
	}

	override getRenderRevision(): number {
		return this.textRenderRevision();
	}

	renderDensityCard(): DensityCardStructuredView {
		const { context, result } = this.state;
		const { args } = context;
		const operation = result?.details?.op ?? args.op;
		const settled = context.hasResult && !context.isPartial;
		const targetsChecklistTask = operation === "start" || operation === "done" || operation === "drop";
		const task =
			targetsChecklistTask && args.task && settled && !context.isError
				? fuzzyResolveTask(result?.details?.phases ?? [], args.task).hit?.task
				: undefined;
		const target = sanitizeTodoText(task?.content ?? args.task ?? args.phase ?? "");
		const name: DensityCardText =
			task?.status === "completed" || task?.status === "abandoned"
				? [{ text: target, strikethrough: true, italic: task.status === "completed" }]
				: target;
		let label: DensityCardText | undefined;
		let statusGlyph: string | undefined;
		switch (operation) {
			case "init": {
				const counts = countInitItems(args);
				label = `init (${countLabel(counts.phases, "phase")}, ${countLabel(counts.tasks, "task")})`;
				statusGlyph = "+";
				break;
			}
			case "append":
				label = `append: ${sanitizeTodoText(args.phase ?? "") || "(missing phase)"} (${countLabel(args.items?.length ?? 0, "item")})`;
				statusGlyph = "+";
				break;
			case "done":
				label = target ? name : "done";
				statusGlyph = "✓";
				break;
			case "drop":
				label = target ? name : "drop";
				statusGlyph = "×";
				break;
			case "start":
				label = target ? `start: ${target}` : "start";
				break;
			case "rm":
				label = `rm: ${target || "all"}`;
				break;
			case "view":
				label = "view";
				break;
			case undefined:
				break;
		}
		return {
			format: "structured",
			kind: "todo",
			heading: { details: label ? [label] : [] },
			...(context.isError
				? { status: "failed" }
				: settled
					? statusGlyph === undefined
						? {}
						: { statusGlyph }
					: { status: context.executionStarted ? "running" : "pending" }),
			body: [
				{
					type: "rich",
					render: (width) => {
						if (!result) return [];
						const checklist = context.isError ? "" : renderChecklist(this.state, this.theme);
						if (checklist) return wrapTextWithAnsi(checklist, width);
						// Replayed and thrown results carry the Ask inside the generated summary header.
						const text = getTextContent(result).replace(
							/(^|\n\n)Ask: [^\n]*\n(?=Now: [^\n]*\nNext: [^\n]*\n\n)/u,
							"$1",
						);
						if (context.isError) return text ? wrapTextWithAnsi(this.theme.fg("toolOutput", text), width) : [];
						return wrapTextWithAnsi(text || "Todo list is empty.", width);
					},
				},
			],
			sections: [],
		};
	}
}
