import { type DensityCardKind, sanitizeTerminalLabel } from "@earendil-works/pi-tui";

export type ToolDensityStatus = "pending" | "running" | "queued" | "detached" | "done" | "failed" | "cancelled";

type ToolSummaryInput = {
	readonly name: string;
	readonly label: string | undefined;
	readonly args: unknown;
	readonly details: unknown;
	readonly pending: boolean;
	readonly started: boolean;
	readonly failed: boolean;
};

/** Recognize palette roles from the tool identity, not from the rendered heading. */
export function toolDensityKind(name: string): DensityCardKind | undefined {
	switch (name) {
		case "eval":
			return "eval";
		case "bash":
		case "powershell":
		case "bash_output":
		case "bash_input":
		case "bash_resize":
		case "kill_bash":
			return "shell";
		case "read":
			return "read";
		case "grep":
		case "find":
		case "glob":
		case "ls":
		case "webfetch":
			return "search";
		case "todo":
			return "todo";
		case "create_goal":
		case "update_goal":
			return "goal";
		case "memory":
			return "memory";
		case "task_send":
			return "message";
		case "task":
		case "task_output":
		case "task_cancel":
			return "task";
		case "edit":
		case "write":
		case "apply_patch":
		case "tool_search":
			return "tool";
		default:
			return undefined;
	}
}

/** Describe a tool without painting its output or exposing raw result content. */
export function toolDensitySummary(input: ToolSummaryInput): {
	readonly name?: string;
	readonly detail: string;
	readonly attention?: string;
	readonly status: ToolDensityStatus;
} {
	const { name, args, details, pending, started, failed } = input;
	const status = failed ? "failed" : pending ? (started ? "running" : "pending") : "done";
	if (name !== "eval") {
		const tool = text(name) ?? "Tool";
		const label = text(input.label);
		return { name: tool, detail: label && label !== tool ? ` · ${label}` : "", status };
	}

	const action = field(args, "action");
	if (action === "list" || field(details, "action") === "list") {
		const cells = field(details, "cells");
		if (!Array.isArray(cells)) return { name: "eval list", detail: "", status };
		const counts = new Map<ToolDensityStatus, number>();
		for (const cell of cells) {
			const state = cellStatus(field(cell, "state"));
			if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
		}
		const unit = cells.length === 1 ? "cell" : "cells";
		const failedCells = counts.get("failed") ?? 0;
		const cancelledCells = counts.get("cancelled") ?? 0;
		if (failedCells || cancelledCells) {
			const attention = [
				failedCells ? `${failedCells} failed` : undefined,
				cancelledCells ? `${cancelledCells} cancelled` : undefined,
			]
				.filter(Boolean)
				.join(", ");
			return {
				name: "eval list",
				detail: ` · ${cells.length} ${unit}`,
				attention,
				status: failed || failedCells ? "failed" : "cancelled",
			};
		}
		const [onlyState] = counts;
		if (counts.size === 1 && onlyState && onlyState[1] === cells.length) {
			const state = onlyState[0] === "done" ? "completed" : onlyState[0];
			return { name: "eval list", detail: ` · ${cells.length} ${state} ${unit}`, status };
		}
		const states = (["pending", "queued", "running", "detached", "done"] as const)
			.flatMap((state) => {
				const count = counts.get(state);
				return count ? [`${count} ${state === "done" ? "completed" : state}`] : [];
			})
			.join(", ");
		return { name: "eval list", detail: ` · ${cells.length} ${unit}${states ? ` (${states})` : ""}`, status };
	}

	const cells = field(details, "cells");
	const firstCell: unknown = Array.isArray(cells) ? cells[0] : undefined;
	const summary = text(field(details, "summary")) ?? text(field(args, "summary")) ?? text(field(firstCell, "summary"));
	const language = text(field(details, "language")) ?? text(field(args, "language"));
	const control = action === "peek" || action === "stop" ? action : undefined;
	const title = control ? `eval ${control}` : language ? `eval ${language}` : "eval";
	const outcome = failed ? status : (cellStatus(field(firstCell, "status")) ?? status);
	return summary === undefined ? { name: title, detail: "", status: outcome } : { detail: summary, status: outcome };
}

// Tool arguments and result details come from the model and extensions respectively.
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? sanitizeTerminalLabel(value) || undefined : undefined;
}

function cellStatus(value: unknown): ToolDensityStatus | undefined {
	switch (value) {
		case "pending":
		case "queued":
		case "running":
		case "detached":
		case "failed":
		case "cancelled":
			return value;
		case "complete":
		case "completed":
			return "done";
		case "error":
			return "failed";
		default:
			return undefined;
	}
}
