import { type DensityCardStructuredView, type DensityCardView, sanitizeTerminalLabel } from "@earendil-works/pi-tui";

type RecordValue = Record<string, unknown>;
type OmoCard = DensityCardStructuredView;

/** Project recognized stock OmO tool results into dense cards without changing their default renderer. */
export function omoTaskDensityCard(input: {
	readonly toolName: string;
	readonly args: unknown;
	readonly result: { readonly details?: unknown; readonly isError: boolean } | undefined;
}): DensityCardView | undefined {
	if (!input.result || !isRecord(input.args) || !isRecord(input.result.details)) return undefined;
	switch (input.toolName) {
		case "task_send":
			return messageCard(input.args, input.result.details, input.result.isError);
		case "task_output":
			return outputCard(input.args, input.result.details, input.result.isError);
		case "task":
			return taskCard(input.args, input.result.details, input.result.isError);
		default:
			return undefined;
	}
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function card(kind: OmoCard["kind"], detail: string, glyph: string, lines: readonly string[]): OmoCard {
	return {
		format: "structured",
		kind,
		heading: { details: detail ? [detail] : [] },
		statusGlyph: glyph,
		body: [{ type: "text", lines }],
		sections: [],
	};
}

function label(value: string): string {
	return sanitizeTerminalLabel(value.replace(/\s+/gu, " "));
}

function nicknamedWorker(worker: RecordValue): string | undefined {
	const taskId = label(text(worker.task_id) ?? "");
	const nickname = label(text(worker.nickname) ?? "");
	if (!taskId || !nickname) return undefined;
	const name = label(text(worker.name) ?? "");
	const address = name && name !== nickname ? name : taskId;
	return nickname === address ? address : `${nickname} (${address})`;
}

function messageCard(args: RecordValue, details: RecordValue, isError: boolean): OmoCard | undefined {
	const recipient = text(args.to);
	const kind = text(details.kind);
	if (!recipient || !kind) return undefined;
	let state: string;
	let failure = isError;
	switch (kind) {
		case "steered":
			if (details.delivered !== "steer" || !text(details.task_id) || !text(details.status)) return undefined;
			state = "steered";
			break;
		case "delivering":
			if (!text(details.to) || (details.reason !== "host_slow" && details.reason !== "aborted")) return undefined;
			state = `background (${details.reason})`;
			break;
		case "queued":
			if (!text(details.task_id) || typeof details.queue_position !== "number") return undefined;
			state = `queued (position ${details.queue_position})`;
			break;
		case "held":
		case "revived":
		case "redispatched":
			if (!text(details.task_id)) return undefined;
			state = kind;
			break;
		case "team_message": {
			if (!isRecord(details.team) || !text(details.team.kind)) return undefined;
			if (details.team.kind === "to_lead" || details.team.kind === "to_members") {
				if (!text(details.team.message_id)) return undefined;
				state = "enqueued";
			} else {
				if (
					![
						"recipient_backpressure",
						"invalid_recipient",
						"payload_too_large",
						"broadcast_denied",
						"team_deleting",
					].includes(String(details.team.kind)) ||
					!text(details.team.reason)
				)
					return undefined;
				failure = true;
				state = `${String(details.team.kind).replaceAll("_", " ")}: ${details.team.reason}`;
			}
			break;
		}
		case "shutdown_requested":
			if (!text(details.team_run_id) || !text(details.member)) return undefined;
			state = "shutdown requested";
			break;
		case "shutdown_responded":
			if (!text(details.team_run_id) || !text(details.member) || typeof details.approved !== "boolean")
				return undefined;
			state = details.approved ? "shutdown approved" : "shutdown rejected";
			break;
		case "unresponsive":
		case "uncertain":
		case "failed":
		case "delivery_uncertain":
		case "capacity_deferred":
		case "invalid_state":
		case "respawn_failed":
		case "not_continuable":
		case "one_shot_agent":
		case "scope_denied":
		case "not_found":
		case "invalid_arguments":
		case "aborted":
		case "send_failed":
		case "shutdown_failed":
		case "admission_refused":
		case "cwd_unavailable":
		case "config_generation_mismatch":
			failure = true;
			state = [kind.replaceAll("_", " "), text(details.reason), text(details.detail)].filter(Boolean).join(": ");
			break;
		default:
			return undefined;
	}
	const message =
		typeof args.message === "string"
			? args.message
			: isRecord(args.message)
				? JSON.stringify(args.message)
				: undefined;
	const lines = [state, ...(message === undefined ? [] : [message])];
	const worker =
		kind === "team_message" ||
		kind === "shutdown_requested" ||
		kind === "shutdown_responded" ||
		kind === "not_found" ||
		kind === "invalid_arguments" ||
		kind === "scope_denied"
			? undefined
			: nicknamedWorker(details);
	return card("outgoing-message", worker ?? label(recipient), failure ? "✗" : "→", lines);
}

function outputCard(args: RecordValue, details: RecordValue, isError: boolean): OmoCard | undefined {
	const mode = args.mode === undefined ? "status" : args.mode;
	if (mode !== "status" && mode !== "tail" && mode !== "full") return undefined;
	const kind = text(details.kind);
	if (!kind) return undefined;
	const snapshot = isRecord(details.snapshot) ? details.snapshot : undefined;
	const id = text(snapshot?.task_id) ?? text(details.task_id) ?? text(args.task_id) ?? text(args.name);
	if (!id) return undefined;
	const lines: string[] = [];
	switch (kind) {
		case "status":
		case "transcript": {
			if (!snapshot || !text(snapshot.status)) return undefined;
			lines.push(`status: ${snapshot.status}`);
			const agent = text(snapshot.agent_type) ?? text(snapshot.category);
			const model = modelDisplay(snapshot);
			if (agent) lines.push(`agent: ${agent}${model ? ` (${model})` : ""}`);
			else if (model) lines.push(`model: ${model}`);
			if (mode === "tail") {
				const limit = args.tail_lines === undefined ? 60 : args.tail_lines;
				if (typeof limit === "number") lines.push(`requested tail: ${limit} lines`);
			}
			if (kind === "transcript") {
				if (
					(details.mode !== "tail" && details.mode !== "full") ||
					(details.source !== "event-log" && details.source !== "session-jsonl" && details.source !== "none") ||
					typeof details.transcript !== "string" ||
					typeof details.truncated !== "boolean"
				)
					return undefined;
				lines.push(`source: ${details.source}`);
				if (details.truncated) lines.push("truncated: yes");
				lines.push(`transcript: ${details.transcript}`);
			} else {
				const response = text(snapshot.final_response);
				if (response) lines.push(`result: ${response}`);
			}
			break;
		}
		case "no_progress":
			if (!text(details.task_id) || !text(details.status) || !text(details.reason)) return undefined;
			lines.push(`status: ${details.status}`, `detail: ${details.reason}`);
			break;
		case "not_found":
		case "invalid_arguments":
			if (!text(details.reason)) return undefined;
			lines.push(`error: ${details.reason}`);
			break;
		default:
			return undefined;
	}
	const worker = snapshot && (kind === "status" || kind === "transcript") ? nicknamedWorker(snapshot) : undefined;
	return card(
		"task-peek",
		`${mode} ${worker ?? label(id)}`,
		isError || kind === "not_found" || kind === "invalid_arguments" ? "✗" : "◉",
		lines,
	);
}

function modelDisplay(value: RecordValue): string | undefined {
	const effective = isRecord(value.effective_model) ? text(value.effective_model.display) : undefined;
	const resolved = isRecord(value.resolved_model) ? text(value.resolved_model.display) : undefined;
	return effective ?? resolved ?? text(value.model);
}

function taskCard(args: RecordValue, details: RecordValue, isError: boolean): OmoCard | undefined {
	if (details.mode !== "spawn" || typeof details.task_id !== "string" || !text(details.status)) return undefined;
	const status = text(details.status);
	const items = Array.isArray(details.items) ? details.items : undefined;
	if (items && !items.every(isRecord)) return undefined;
	const id = text(details.task_id);
	const failed =
		isError ||
		[
			"error",
			"cancelled",
			"interrupted",
			"lost",
			"denied",
			"invalid_arguments",
			"residency_denied",
			"plan_error",
		].includes(status ?? "");
	const title = text(details.task_summary) ?? text(args.task_summary) ?? text(args.description) ?? text(args.prompt);
	const worker = items ? undefined : nicknamedWorker(details);
	const suffix = `${worker ?? label(id ?? "")}${title ? `${id ? " " : ""}"${label(title)}"` : ""}`;
	const lines: string[] = [];
	if (items) {
		for (const item of items) {
			if (!isRecord(item) || typeof item.task_id !== "string" || !text(item.status)) return undefined;
			const itemId = text(item.task_id);
			const itemWorker = nicknamedWorker(item);
			const itemTitle = text(item.task_summary) ?? (itemWorker === undefined ? text(item.name) : undefined);
			lines.push(
				[itemWorker ?? itemId ?? "task", itemTitle, text(item.status), text(item.error_message)]
					.filter(Boolean)
					.join(" · "),
			);
		}
	} else {
		const agent = text(details.subagent_type) ?? text(details.category);
		const model = modelDisplay(details);
		if (agent) lines.push(`agent: ${agent}${model ? ` (${model})` : ""}`);
		else if (model) lines.push(`model: ${model}`);
		if (!(details.run_in_background === true && status === "running")) lines.push(`status: ${status}`);
		if (typeof details.queue_position === "number") lines.push(`queue: ${details.queue_position}`);
		if (text(details.reason)) lines.push(`detail: ${details.reason}`);
	}
	return card("task", suffix, failed ? "✗" : id ? "+" : "○", lines);
}
