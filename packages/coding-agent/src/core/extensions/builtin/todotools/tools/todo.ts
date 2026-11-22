// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { type Static, Type } from "typebox";
import { resolvePromptSurface } from "../../../../dynamic-prompt/build.ts";
import { resolveActivePresetName } from "../../prompt-preset/active-preset.ts";
import { presetHandoffCueKind } from "../../prompt-preset/contract.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../types.ts";
import { normalizeTodoParams, prepareTodoArguments, splitPreparedCorrections } from "../normalize.ts";
import { TODO_TOOL_DESCRIPTION } from "../prompt.ts";
import {
	applyParams,
	captureListAsk,
	clonePhases,
	formatHandoffCue,
	formatSummary,
	getCompletionTransitions,
	handoffMomentOf,
	TODO_STATE_ENTRY_TYPE,
	type TodoAsk,
	type TodoCompletionTransition,
	type TodoPhase,
	type TodoStateEntry,
	type TodoToolDetails,
} from "../state.ts";

import { renderTodoCall, renderTodoResult } from "./todo-card.ts";
export { phaseRomanNumeral } from "./todo-checklist.ts";

const TodoOperationSchema = Type.Union(
	[
		Type.Literal("init"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("rm"),
		Type.Literal("drop"),
		Type.Literal("append"),
		Type.Literal("view"),
	],
	{ description: "Operation to perform. Required: always pass it explicitly." },
);

const TodoPhaseInputSchema = Type.Object({
	phase: Type.String({ description: "Phase name" }),
	items: Type.Array(Type.String({ description: "Task content" }), {
		description: "Tasks for this phase",
		minItems: 1,
	}),
});

export const TODO_PARAMS_SCHEMA = Type.Object({
	op: Type.Optional(TodoOperationSchema),
	list: Type.Optional(Type.Array(TodoPhaseInputSchema, { description: "Phased task list for init" })),
	task: Type.Optional(Type.String({ description: "Exact task text copied from the previous todo result" })),
	phase: Type.Optional(Type.String({ description: "Exact phase name copied from the previous todo result" })),
	// Keep this unconstrained at the schema boundary. init and append return
	// operation-specific errors, while unrelated operations may ignore it.
	items: Type.Optional(
		Type.Array(Type.String({ description: "Task content" }), { description: "Task texts to append" }),
	),
});

export type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;

type TodoAccessors = {
	getCurrentPhases: () => TodoPhase[];
	setCurrentPhases: (phases: TodoPhase[]) => void;
	getCurrentAsk: () => TodoAsk | undefined;
	setCurrentAsk: (ask: TodoAsk | undefined) => void;
	syncWidget: (ctx: ExtensionContext, completedTasks?: readonly TodoCompletionTransition[]) => void;
	/** Records a call this extension instance executed, so its own result is not adopted again as a foreign list. */
	noteExecuted?: (toolCallId: string) => void;
};

export function registerTodoTool(pi: ExtensionAPI, accessors: TodoAccessors): void {
	const tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA, TodoToolDetails, unknown> = {
		name: "todo",
		runs: "brain",
		sessionBound: true,
		workspaceEffect: "read",
		label: "Todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: "Track phased tasks with one op-based todo tool; reference tasks by their exact content.",
		fullPromptGuidelines: [
			"Use one todo operation at a time, batched with the real work; never end a turn with a todo call as its only tool call.",
			"Reference tasks and phases by their exact content/name; use view when the text is uncertain.",
			"Mark work done immediately and use drop for tasks that are no longer needed.",
		],
		parameters: TODO_PARAMS_SCHEMA,
		prepareArguments: (args) => prepareTodoArguments(args) as TodoParams,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TodoToolDetails>> {
			accessors.noteExecuted?.(toolCallId);
			const previousPhases = clonePhases(accessors.getCurrentPhases());
			const previousAsk = accessors.getCurrentAsk();
			// prepareTodoArguments carries its notices on the prepared args under a reserved key
			// (#5332). The key is stripped here before normalizing and is never persisted or
			// rendered, but the prepared arguments — key included — flow to the agent loop's
			// beforeToolCall/afterToolCall hooks, so extension tool_call/tool_result hooks may
			// observe it on the arguments they receive.
			const prepared = splitPreparedCorrections(params as Record<string, unknown>);
			const normalized = normalizeTodoParams(prepared.args, previousPhases);
			if (normalized.error || !normalized.entry) {
				const error =
					normalized.error ?? 'Missing "op". Example: {"op":"init","list":[{"phase":"Setup","items":["..."]}]}';
				throw new Error(`${error}\n\n${formatSummary(previousPhases, [], true, previousAsk)}`);
			}
			const entry = normalized.entry;
			const corrections = [...prepared.corrections, ...normalized.corrections];
			const readOnly = entry.op === "view";
			const errors: string[] = [];
			const applied = readOnly
				? { phases: previousPhases, errors }
				: applyParams(clonePhases(previousPhases), entry, corrections);
			if (applied.errors.length > 0) {
				throw new Error(formatSummary(previousPhases, applied.errors, readOnly, previousAsk));
			}
			const completedTasks = readOnly ? [] : getCompletionTransitions(previousPhases, applied.phases);
			// Only a list-creating call re-anchors the ask; every other op keeps it.
			const createsList =
				entry.op === "init" || (entry.op === "append" && previousPhases.every((phase) => phase.tasks.length === 0));
			const ask = createsList
				? (captureListAsk(ctx.sessionManager.getBranch(), Date.now()) ?? previousAsk)
				: previousAsk;
			if (!readOnly) {
				pi.appendEntry(TODO_STATE_ENTRY_TYPE, {
					schema: "v2",
					phases: clonePhases(applied.phases),
					...(ask ? { ask } : {}),
				} satisfies TodoStateEntry);
				accessors.setCurrentPhases(clonePhases(applied.phases));
				accessors.setCurrentAsk(ask);
				accessors.syncWidget(ctx, completedTasks);
			}

			const details: TodoToolDetails = {
				op: entry.op,
				phases: clonePhases(applied.phases),
				storage: ctx.sessionManager.getSessionFile() ? "session" : "memory",
			};
			if (ask) details.ask = ask;
			if (corrections.length > 0) details.corrections = corrections;
			if (completedTasks.length > 0) details.completedTasks = completedTasks;
			// A chat surface posts replies to a conversation, which has no handoff block to cue (senpi#2398).
			const surface = ctx.getSystemPromptOptions?.().surface ?? resolvePromptSurface(process.env);
			// The cue must name the handoff block the session's prompt defines: the GPT block presets
			// cue their outcome-first block, the rewritten gpt-6.2 core defines no block to cue, and every
			// other core keeps the default Ask / For you cue (senpi#6977).
			const cue = formatHandoffCue(
				readOnly || surface === "chat" ? undefined : handoffMomentOf(previousPhases, applied.phases, createsList),
				presetHandoffCueKind(resolveActivePresetName(ctx)),
			);
			const summary = `${formatSummary(applied.phases, [], readOnly, ask)}${cue}`;
			const text = corrections.length > 0 ? `${corrections.join("\n")}\n\n${summary}` : summary;

			return { content: [{ type: "text", text }], details };
		},
		renderCall: renderTodoCall,
		renderResult: renderTodoResult,
	};

	pi.registerTool(tool);
}
