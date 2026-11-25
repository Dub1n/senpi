import {
	type DensityCardStructuredView,
	type DensityCardText,
	type DensityCardView,
	sanitizeTerminalLabel,
} from "@earendil-works/pi-tui";

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

function card(
	kind: OmoCard["kind"],
	details: readonly DensityCardText[],
	glyph: string,
	lines: readonly DensityCardText[],
): OmoCard {
	return {
		format: "structured",
		kind,
		heading: { details },
		statusGlyph: glyph,
		body: [{ type: "text", lines }],
		sections: [],
	};
}

function label(value: string): string {
	return sanitizeTerminalLabel(value.replace(/\s+/gu, " "));
}

function span(value: string, role: "dim" | "text" = "text", italic = false): DensityCardText {
	return [{ text: label(value), role, ...(italic ? { italic: true } : {}) }];
}

function taskIdentity(value: RecordValue): string {
	const id = text(value.task_id);
	const nickname = label(text(value.nickname) ?? "");
	return nickname || label(id ? `id: ${id}` : (text(value.name) ?? ""));
}

function modelDisplay(value: RecordValue): string | undefined {
	const effective = isRecord(value.effective_model) ? value.effective_model : undefined;
	const resolved = isRecord(value.resolved_model) ? value.resolved_model : undefined;
	const source = effective ?? resolved;
	const display = text(source?.display) ?? text(source?.model_id) ?? text(value.model);
	const id = (text(source?.model_id) ?? display)?.split("/").at(-1);
	const namedGpt = id && /^gpt[- ]\d+(?:\.\d+)?[- ](luna|sol|astra|terra)(?:[- ]fast)?$/iu.exec(id)?.[1];
	const effort = (
		text(source?.reasoning) ??
		text(source?.reasoning_effort) ??
		text(source?.variant) ??
		text(value.reasoning_effort) ??
		text(value.variant)
	)?.toLowerCase();
	const name = namedGpt ? namedGpt[0].toUpperCase() + namedGpt.slice(1).toLowerCase() : display;
	return [name, effort].filter(Boolean).join(" ") || undefined;
}

function taskStatusGlyph(status: string): string {
	if (status === "pending" || status === "queued") return "○";
	if (
		[
			"error",
			"cancelled",
			"interrupted",
			"lost",
			"denied",
			"invalid_arguments",
			"residency_denied",
			"plan_error",
		].includes(status)
	)
		return "✗";
	return "+";
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
	const lines: DensityCardText[] = [state];
	const taskId = text(details.task_id);
	const agent = text(details.subagent_type) ?? text(details.category) ?? text(details.agent_type);
	if (taskId) lines.push(span(`id: ${taskId}`));
	if (agent) lines.push(span(`agent: ${agent}`));
	if (message !== undefined)
		lines.push(...message.split(/\r?\n/u).map((line) => [{ text: line, role: "dim" as const, italic: true }]));
	const worker =
		kind === "team_message" ||
		kind === "shutdown_requested" ||
		kind === "shutdown_responded" ||
		kind === "not_found" ||
		kind === "invalid_arguments" ||
		kind === "scope_denied"
			? undefined
			: taskIdentity(details);
	const identity = worker || label(recipient);
	const model = modelDisplay(details);
	const heading = [span(identity), ...(model ? [span(model)] : [])] as const;
	return card("outgoing-message", heading, failure ? "✗" : "→", lines);
}

function outputCard(args: RecordValue, details: RecordValue, isError: boolean): OmoCard | undefined {
	const mode = args.mode === undefined ? "status" : args.mode;
	if (mode !== "status" && mode !== "tail" && mode !== "full") return undefined;
	const kind = text(details.kind);
	if (!kind) return undefined;
	const snapshot = isRecord(details.snapshot) ? details.snapshot : undefined;
	const id = text(snapshot?.task_id) ?? text(details.task_id) ?? text(args.task_id) ?? text(args.name);
	if (!id) return undefined;
	const lines: DensityCardText[] = [];
	switch (kind) {
		case "status":
		case "transcript": {
			if (!snapshot || !text(snapshot.status)) return undefined;
			lines.push(span(`id: ${id}`));
			lines.push(`status: ${snapshot.status}`);
			const agent = text(snapshot.agent_type) ?? text(snapshot.category);
			const model = modelDisplay(snapshot);
			if (agent) lines.push(span(`agent: ${agent}${model ? ` (${model})` : ""}`));
			else if (model) lines.push(span(`model: ${model}`));
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
			lines.push(span(`id: ${details.task_id}`));
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
	const worker = kind === "status" || kind === "transcript" ? snapshot : kind === "no_progress" ? details : undefined;
	const model = worker ? modelDisplay(worker) : undefined;
	const identity = (worker && taskIdentity(worker)) || `id: ${id}`;
	const heading = [span(`${mode} ${identity}`), ...(model ? [span(model)] : [])];
	return card(
		"task-peek",
		heading,
		isError || kind === "not_found" || kind === "invalid_arguments" ? "✗" : "◉",
		lines,
	);
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
	const taskArgs = Array.isArray(args.tasks) ? args.tasks : undefined;
	const itemSummary = (item: RecordValue, index: number): string | undefined => {
		const itemArgs = taskArgs && isRecord(taskArgs[index]) ? taskArgs[index] : undefined;
		return (
			text(item.task_summary) ??
			text(itemArgs?.task_summary) ??
			text(itemArgs?.description) ??
			(items ? undefined : (text(details.task_summary) ?? text(args.task_summary) ?? text(args.description)))
		);
	};
	const itemPrompt = (index: number): string | undefined => {
		const itemArgs = taskArgs && isRecord(taskArgs[index]) ? taskArgs[index] : undefined;
		return items ? text(itemArgs?.prompt) : text(args.prompt);
	};
	const expandedDetails = (item: RecordValue, index: number): DensityCardText[] => {
		const identity = taskIdentity(item);
		const model = modelDisplay(item);
		const summary = itemSummary(item, index);
		return [span(identity), ...(model ? [span(model)] : []), ...(summary ? [span(`"${label(summary)}"`)] : [])];
	};
	const workerBody = (item: RecordValue, index: number, hideRunningStatus: boolean): OmoCard["body"] => {
		const lines: DensityCardText[] = [];
		const taskId = text(item.task_id);
		const agent = text(item.subagent_type) ?? text(item.category) ?? text(item.agent_type);
		const itemStatus = text(item.status);
		const queue = item.queue_position;
		const failure = text(item.error_message) ?? text(item.reason);
		const fallbacks = Array.isArray(item.fallback_attempts)
			? item.fallback_attempts
					.filter(isRecord)
					.map((fallback) => {
						const display = text(fallback.display);
						const effort = text(fallback.reasoning) ?? text(fallback.reasoning_effort) ?? text(fallback.variant);
						return [display, effort?.toLowerCase()].filter(Boolean).join(" ") || undefined;
					})
					.filter((model): model is string => model !== undefined)
			: [];
		const prompt = itemPrompt(index);
		if (taskId) lines.push(span(`id: ${taskId}`));
		if (agent) lines.push(`agent: ${label(agent)}`);
		if (itemStatus && !(hideRunningStatus && itemStatus === "running")) lines.push(`status: ${label(itemStatus)}`);
		if (typeof queue === "number") lines.push(`queue: ${queue}`);
		if (failure) lines.push(`detail: ${label(failure)}`);
		if (fallbacks.length > 0) lines.push(`fallbacks: ${fallbacks.join(" → ")}`);
		if (prompt !== undefined) lines.push([{ text: sanitizeTerminalLabel(prompt), role: "dim", italic: true }]);
		return lines.length > 0 ? [{ type: "text", lines }] : [];
	};
	let heading: DensityCardText[];
	let expandedHeading: DensityCardText[];
	let body: OmoCard["body"];
	const sections: DensityCardStructuredView["sections"][number][] = [];
	if (items) {
		const workers = items.map((item, index) => {
			if (typeof item.task_id !== "string" || !text(item.status)) return undefined;
			const identity = taskIdentity(item);
			const model = modelDisplay(item);
			return { item, index, identity, model };
		});
		if (workers.some((worker) => worker === undefined)) return undefined;
		const resolvedWorkers = workers.filter((worker) => worker !== undefined);
		heading = resolvedWorkers.length
			? resolvedWorkers.map(({ identity, model }) => span(model ? `${identity} (${model})` : identity))
			: [span(taskIdentity(details))];
		const first = resolvedWorkers[0];
		expandedHeading = first ? expandedDetails(first.item, first.index) : [span(label(id ?? "task"))];
		body = first ? workerBody(first.item, first.index, false) : [];
		for (const worker of resolvedWorkers.slice(1)) {
			sections.push({
				placement: "frame",
				heading: {
					kind: "task",
					heading: { details: expandedDetails(worker.item, worker.index) },
					statusGlyph: taskStatusGlyph(text(worker.item.status) ?? ""),
				},
				body: workerBody(worker.item, worker.index, false),
			});
		}
	} else {
		heading = expandedDetails(details, 0);
		expandedHeading = heading;
		body = workerBody(details, 0, details.run_in_background === true);
	}
	const firstStatus = items?.[0] && text(items[0].status);
	return {
		format: "structured",
		kind: "task",
		heading: { details: heading },
		expandedHeading: { details: expandedHeading },
		statusGlyph: firstStatus ? taskStatusGlyph(firstStatus) : failed ? "✗" : id ? "+" : "○",
		body,
		sections,
	};
}
