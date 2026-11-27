import {
	type DensityCardKind,
	type DensityCardStatus,
	getGraphemeSegmenter,
	visibleWidth,
} from "@earendil-works/pi-tui";

type IconVariant = {
	readonly id: string;
	readonly label: string;
	readonly defaultGlyph: string;
};

type IconGroup = {
	readonly label: string;
	readonly variants: readonly IconVariant[];
};

function single(id: string, label: string, defaultGlyph: string): IconGroup {
	return { label, variants: [{ id, label, defaultGlyph }] };
}

export const toolCardIconGroups: readonly IconGroup[] = [
	single("added", "Added", "✓"),
	{
		label: "Bash",
		variants: [
			{ id: "shell", label: "Command", defaultGlyph: "✓" },
			{ id: "bash-output", label: "Output", defaultGlyph: "✓" },
			{ id: "bash-output.killed", label: "Killed or stopped", defaultGlyph: "×" },
			{ id: "bash-output.attention", label: "Needs attention", defaultGlyph: "!" },
			{ id: "bash-output.mixed", label: "Mixed outcomes", defaultGlyph: "~" },
		],
	},
	single("compaction", "Compacted", "✓"),
	single("deleted", "Deleted", "✓"),
	single("edited", "Edited", "✓"),
	single("eval", "Eval", "✓"),
	single("find", "Find", "✓"),
	{
		label: "Goal",
		variants: [
			{ id: "goal.active", label: "Active", defaultGlyph: "●" },
			{ id: "goal.paused", label: "Paused", defaultGlyph: "◌" },
			{ id: "goal.blocked", label: "Blocked", defaultGlyph: "■" },
			{ id: "goal.complete", label: "Completed", defaultGlyph: "✓" },
			{ id: "goal.cache-warm", label: "Cache warm", defaultGlyph: "↯" },
		],
	},
	single("grep", "Grep", "✓"),
	single("incoming-message", "Incoming message", "←"),
	{
		label: "Kibitz",
		variants: [
			{ id: "kibitz", label: "Delivered", defaultGlyph: "✦" },
			{ id: "kibitz.warning", label: "Skipped or needs attention", defaultGlyph: "⚠" },
		],
	},
	single("loop-guard", "Loop guard", "!"),
	single("ls", "List", "✓"),
	single("memory", "Remembered", "●"),
	single("message", "Message", "✓"),
	single("outgoing-message", "Outgoing message", "→"),
	single("patched", "Patched", "✓"),
	single("powershell", "PowerShell", "✓"),
	single("project-rules", "Project rules", "●"),
	{
		label: "Question",
		variants: [
			{ id: "question", label: "Asked", defaultGlyph: "?" },
			{ id: "question.cancelled", label: "Cancelled", defaultGlyph: "×" },
		],
	},
	single("read", "Read", "✓"),
	single("rules", "Rules", "●"),
	single("search", "Search", "✓"),
	single("skill", "Skill", "●"),
	{
		label: "System",
		variants: [
			{ id: "system", label: "Ready", defaultGlyph: "✓" },
			{ id: "system.info", label: "Information", defaultGlyph: "i" },
			{ id: "system.warning", label: "Warning", defaultGlyph: "!" },
			{ id: "system.error", label: "Error", defaultGlyph: "×" },
			{ id: "system.deferred", label: "Hot reload deferred", defaultGlyph: "Ⅱ" },
		],
	},
	single("task", "Task started", "+"),
	single("task-peek", "Task peek", "◉"),
	{
		label: "Todo",
		variants: [
			{ id: "todo.added", label: "Added", defaultGlyph: "+" },
			{ id: "todo.started", label: "Started", defaultGlyph: "▶" },
			{ id: "todo.completed", label: "Completed", defaultGlyph: "✓" },
			{ id: "todo.cancelled", label: "Cancelled", defaultGlyph: "×" },
		],
	},
	single("tool", "Other tool", "✓"),
	single("tool.failed", "Tool failed", "✗"),
	single("tool.notice", "Tool notice", "›"),
	{
		label: "Tool execution",
		variants: [
			{ id: "tool.pending", label: "Pending or running", defaultGlyph: "○" },
			{ id: "tool.detached", label: "Detached", defaultGlyph: "↗" },
			{ id: "tool.cancelled", label: "Cancelled", defaultGlyph: "×" },
		],
	},
	single("viewed", "Viewed", "✓"),
	single("wait", "Wait", "↯"),
	single("wake", "Wake", "↯"),
];

const roles = new Set(toolCardIconGroups.flatMap(({ variants }) => variants.map(({ id }) => id)));

export function isToolCardIconRole(id: string): boolean {
	return roles.has(id);
}

/** Accept one printable terminal glyph; measure columns with the renderer's width policy. */
export function isToolCardIcon(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 64 ||
		/[\p{White_Space}\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(value) ||
		!/[^\p{M}\p{Cf}]/u.test(value)
	)
		return false;
	const width = visibleWidth(value);
	if (width !== 1 && width !== 2) return false;
	const segments = getGraphemeSegmenter().segment(value)[Symbol.iterator]();
	segments.next();
	return segments.next().done === true;
}

export type ToolCardIconOverrides = Readonly<Record<string, string>>;

export function toolCardIconOverride(
	overrides: ToolCardIconOverrides | undefined,
	kind: DensityCardKind | undefined,
	glyph: string,
	status?: DensityCardStatus,
): string | undefined {
	if (!overrides) return undefined;
	if (status === "failed" || glyph === "✗") return overrides["tool.failed"];
	if (status === "pending" || status === "queued" || status === "running" || glyph === "○")
		return overrides["tool.pending"];
	if (status === "detached") return overrides["tool.detached"];
	if (status === "cancelled") return overrides["tool.cancelled"];
	if (kind === "todo") {
		switch (glyph) {
			case "+":
				return overrides["todo.added"];
			case "▶":
				return overrides["todo.started"];
			case "✓":
				return overrides["todo.completed"];
			case "×":
				return overrides["todo.cancelled"];
			default:
				return undefined;
		}
	}
	if (kind === "bash-output") {
		switch (glyph) {
			case "×":
				return overrides["bash-output.killed"];
			case "!":
				return overrides["bash-output.attention"];
			case "~":
				return overrides["bash-output.mixed"];
		}
	}
	if (kind === "question" && glyph === "×") return overrides["question.cancelled"];
	if (kind === "kibitz" && glyph === "⚠") return overrides["kibitz.warning"];
	if (kind === "tool" && glyph === "›") return overrides["tool.notice"];
	if (kind === "goal") {
		switch (glyph) {
			case "●":
				return overrides["goal.active"];
			case "◌":
				return overrides["goal.paused"];
			case "■":
				return overrides["goal.blocked"];
			case "✓":
				return overrides["goal.complete"];
			case "↯":
				return overrides["goal.cache-warm"];
		}
	}
	if (kind === "system") {
		switch (glyph) {
			case "i":
				return overrides["system.info"];
			case "!":
				return overrides["system.warning"];
			case "×":
				return overrides["system.error"];
			case "Ⅱ":
				return overrides["system.deferred"];
		}
	}
	if (kind === "edit" || kind === "write") return overrides.edited;
	return overrides[kind ?? "tool"];
}
