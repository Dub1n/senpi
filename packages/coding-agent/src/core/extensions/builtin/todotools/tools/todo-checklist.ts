// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { partialStrikethrough, strikeRevealCount } from "../../../../../modes/interactive/components/todo-strike.ts";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import { getTodoMarker, sanitizeTodoText } from "../todo-format.ts";
import { findTaskByContent, nextActionableTask } from "../todo-query.ts";
import type { TodoCompletionTransition, TodoOperation, TodoPhase, TodoToolDetails } from "../todo-types.ts";

type TodoTarget = { readonly task?: string; readonly phase?: string };
type TodoChecklistView = {
	readonly target: TodoTarget;
	readonly expanded: boolean;
	readonly frame: number | undefined;
};

export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	const pairs: ReadonlyArray<readonly [number, string]> = [
		[1000, "M"],
		[900, "CM"],
		[500, "D"],
		[400, "CD"],
		[100, "C"],
		[90, "XC"],
		[50, "L"],
		[40, "XL"],
		[10, "X"],
		[9, "IX"],
		[5, "V"],
		[4, "IV"],
		[1, "I"],
	];
	let remaining = oneBasedIndex;
	let output = "";
	for (const [value, symbol] of pairs) {
		while (remaining >= value) {
			output += symbol;
			remaining -= value;
		}
	}
	return output;
}

function formatPhaseHeader(name: string, index: number, theme: Theme): string {
	return theme.fg("accent", theme.bold(`${phaseRomanNumeral(index)}. ${sanitizeTodoText(name)}`));
}

function formatPhaseSummary(phase: TodoPhase, index: number, theme: Theme): string {
	const closed = phase.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
	return theme.fg(
		"dim",
		`${phaseRomanNumeral(index)}. ${sanitizeTodoText(phase.name)} - ${closed}/${phase.tasks.length} done`,
	);
}

function formatTaskLine(task: TodoPhase["tasks"][number], theme: Theme, frame: number | undefined): string {
	const content = sanitizeTodoText(task.content);
	const line = `${getTodoMarker(task.status)} ${content}`;
	switch (task.status) {
		case "completed": {
			const reveal = strikeRevealCount(line, frame);
			return reveal === undefined
				? theme.fg("dim", theme.strikethrough(line))
				: theme.fg(
						"dim",
						partialStrikethrough(line, reveal, (text) => theme.strikethrough(text)),
					);
		}
		case "in_progress":
			return theme.fg("accent", theme.bold(line));
		case "abandoned":
			return theme.fg("dim", line);
		case "pending":
			return line;
	}
}

function computeTouchedPhases(
	args: TodoTarget,
	checklist: {
		readonly operation: TodoOperation | undefined;
		readonly phases: readonly TodoPhase[];
		readonly completedTasks: readonly TodoCompletionTransition[];
	},
): Set<string> | null {
	const { operation, phases, completedTasks } = checklist;
	const touched = new Set<string>();
	const activeTask = nextActionableTask(phases);
	if (activeTask) {
		const activePhase = phases.find((phase) => phase.tasks.includes(activeTask));
		if (activePhase) touched.add(activePhase.name);
	}
	for (const transition of completedTasks) touched.add(transition.phase);
	// Exhaustive over TodoOperation | undefined so adding an operation is a typecheck
	// failure here rather than a silent fall-through into target-scoped highlighting.
	switch (operation) {
		case "init":
			for (const phase of phases) touched.add(phase.name);
			break;
		case "start":
		case "done":
		case "drop":
		case "rm":
		case "append":
		case "view":
		case undefined: {
			if (args.phase) {
				const phase = phases.find((candidate) => candidate.name === args.phase);
				if (phase) touched.add(phase.name);
			}
			if (args.task) {
				const hit = findTaskByContent([...phases], args.task);
				if (hit) touched.add(hit.phase.name);
			}
			break;
		}
		default: {
			const _exhaustive: never = operation;
			return touched.size > 0 ? touched : null;
		}
	}
	return touched.size > 0 ? touched : null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function renderTodoPhases(details: TodoToolDetails | undefined, view: TodoChecklistView, theme: Theme): string {
	const visiblePhases = details?.phases.filter((phase) => phase.tasks.length > 0) ?? [];
	if (visiblePhases.length === 0) return "";

	const completedTasks = details?.completedTasks ?? [];
	const touched =
		view.expanded || visiblePhases.length === 1
			? null
			: computeTouchedPhases(view.target, { operation: details?.op, phases: visiblePhases, completedTasks });
	const completionKeysByPhase = new Map<string, Set<string>>();
	for (const transition of completedTasks) {
		let completionKeys = completionKeysByPhase.get(transition.phase);
		if (!completionKeys) {
			completionKeys = new Set();
			completionKeysByPhase.set(transition.phase, completionKeys);
		}
		completionKeys.add(transition.content);
	}
	const lines: string[] = [];
	for (let index = 0; index < visiblePhases.length; index += 1) {
		const phase = visiblePhases[index];
		const oneBasedIndex = index + 1;
		if (touched && !touched.has(phase.name)) {
			lines.push(formatPhaseSummary(phase, oneBasedIndex, theme));
			continue;
		}
		lines.push(formatPhaseHeader(phase.name, oneBasedIndex, theme));
		const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_SET;
		for (const task of phase.tasks) {
			lines.push(`  ${formatTaskLine(task, theme, completionKeys.has(task.content) ? view.frame : undefined)}`);
		}
	}
	return lines.join("\n");
}
