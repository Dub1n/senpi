import { fauxAssistantMessage, fauxToolCall, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { invoke } from "./exploration-surface-harness.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";

const wide = 64;
const densities = ["compact", "grouped"] as const;
type Density = "default" | (typeof densities)[number];
type ToolName = "bash_output" | "kill_bash" | "tool_search";
type Result = Pick<ToolResultMessage, "content" | "details"> & { readonly isError?: boolean | undefined };
type JobWidgetFixture = {
	readonly id: string;
	readonly kind: "bash";
	readonly state: "live";
	readonly view: {
		readonly title: string;
		readonly headline: { readonly text: string };
		readonly blocks: readonly [];
	};
	readonly updatedAtMs: number;
};

const catalogExtensions: HarnessOptions["extensionFactories"] = [
	{ path: "<builtin:tool-search>", factory: toolSearchExtension },
	{
		name: "density-search-fixture",
		factory: (pi) =>
			pi.registerTool({
				name: "weather",
				label: "Weather",
				description: "Local weather",
				exposure: "search",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			}),
	},
];

function rows(width: number, ...body: readonly string[]): readonly string[] {
	return ["", ...["", ...body, ""].map((row) => row.padEnd(width))];
}

async function transcript(
	name: ToolName,
	args: ToolCall["arguments"],
	result: Result,
	layout: { readonly density: Density; readonly expanded: boolean; readonly width: number },
): Promise<readonly string[]> {
	return transcriptHistory(
		[
			fauxAssistantMessage(
				{ type: "toolCall", id: "golden", name, arguments: args },
				{ stopReason: "toolUse", timestamp: 0 },
			),
			{
				role: "toolResult",
				toolName: name,
				toolCallId: "golden",
				timestamp: 0,
				isError: result.isError ?? false,
				content: result.content,
				details: result.details,
			},
		],
		layout,
		name === "tool_search",
	);
}

async function transcriptHistory(
	items: readonly unknown[],
	layout: { readonly density: Density; readonly expanded: boolean; readonly width: number },
	search = false,
): Promise<readonly string[]> {
	const harness = await createHarness({
		settings: { smoothStreaming: false, hideThinkingBlock: true },
		extensionFactories: search
			? catalogExtensions
			: [
					{
						name: "density-terminal",
						factory: (pi) => {
							pi.registerTool(terminalTool);
							pi.registerTool(killTerminalTool);
						},
					},
				],
	});
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(layout.width, 40));
	const chat: unknown = Reflect.get(mode, "chatContainer");
	try {
		if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected exploration chat");
		Reflect.set(mode, "ui", ui);
		Reflect.set(mode, "hideThinkingBlock", true);
		Reflect.set(mode, "getMarkdownTransformers", () => []);
		// The expansion announcement is transient UI feedback, not part of the transcript card.
		Reflect.set(mode, "showStatus", () => {});
		if (search) {
			await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		}
		invoke(mode, "renderSessionItems", items);
		chat.setToolDisplayDensity(layout.density);
		invoke(mode, "setToolsExpanded", layout.expanded);
		return chat.render(layout.width).map(stripTerminalSequences);
	} finally {
		if (chat instanceof ExplorationTranscriptContainer) chat.dispose();
		ui.stop();
		harness.cleanup();
	}
}

const terminalContext = {
	cwd: "/workspace",
	defaultCols: 80,
	defaultRows: 24,
	getEnv: () => ({}),
	manager: new TerminalManager(),
};
const terminalTool = createBashOutputTool(terminalContext);
const killTerminalTool = createKillBashTool(terminalContext);
const bashArgs = { bash_id: "bash_39" };

function text(value: string): Result {
	return { content: [{ type: "text", text: value }], details: undefined };
}

function bashOutput(
	value: string,
	sessionId: string,
	processStatus: string,
	exitCode: number | null,
	notice = "",
	emptyPlaceholder?: "synthetic" | "filtered" | "literal",
	view: "log" | "screen" = "log",
	jobWidget?: JobWidgetFixture,
	noticeDropped = 0,
): Result {
	const statusStart = notice ? notice.length + 1 : 0;
	const statusEnd = value.indexOf("\n", statusStart);
	const rawBody = value.slice(statusEnd + 1);
	const placeholder = emptyPlaceholder ?? (rawBody === "(no new output)" ? "synthetic" : undefined);
	const body = placeholder === undefined || placeholder === "literal" ? rawBody : "";
	return {
		...text(value),
		details: {
			bashOutput: {
				sessionId,
				processStatus,
				exitCode,
				statusStart,
				statusEnd,
				view,
				poll: {
					body,
					bodyFingerprint: body,
					...(placeholder === undefined ? {} : { emptyPlaceholder: placeholder }),
					notices: notice ? { monitorMuted: { dropped: noticeDropped } } : {},
				},
			},
			...(jobWidget === undefined ? {} : { jobWidget }),
		},
	};
}

type BashPollFixture = {
	readonly id: string;
	readonly sessionId: string;
	readonly result: Result;
	readonly view?: "log" | "screen";
	readonly filter?: string;
};

function bashHistory(calls: readonly BashPollFixture[]): unknown[] {
	return [
		fauxAssistantMessage(
			calls.map(({ id, sessionId, view, filter }) =>
				fauxToolCall(
					"bash_output",
					{ bash_id: sessionId, ...(view ? { view } : {}), ...(filter ? { filter } : {}) },
					{ id },
				),
			),
			{ stopReason: "toolUse", timestamp: 0 },
		),
		...calls.map(({ id, result }) => ({
			role: "toolResult",
			toolName: "bash_output",
			toolCallId: id,
			timestamp: 0,
			isError: result.isError ?? false,
			content: result.content,
			details: result.details,
		})),
	];
}

describe.each(densities)("bash output in %s", (density) => {
	it("hides an empty running poll", async () => {
		const result = bashOutput("status: running\n(no new output)", "bash_39", "running", null);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: false, width: wide })).toEqual([]);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: true, width: wide })).toEqual([]);
	});

	it("keeps failed exit status and shell payload distinct from a lookup failure", async () => {
		const result = bashOutput(
			"status: exited_3 exit_code: 3\n  kept indentation\n\nstatus: running",
			"bash_39",
			"exited_3",
			3,
		);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ × bash 39 • exit code 3", " │   kept indentation", " │ ", " │ status: running", " ╰─"),
		);
	});

	it("keeps a nonnumeric session id explicit instead of guessing an identity", async () => {
		const args = { bash_id: "custom-session" };
		const result = bashOutput("status: running\nready", "custom-session", "running", null);
		expect(await transcript("bash_output", args, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash custom-session • running", " │ ready", " ╰─"),
		);
	});

	it("shows the lookup failure from the terminal tool", async () => {
		const result = await terminalTool.execute("missing", bashArgs);
		const diagnostic = result.details?.bashOutputError;
		if (
			diagnostic === null ||
			typeof diagnostic !== "object" ||
			!("kind" in diagnostic) ||
			diagnostic.kind !== "session-not-found" ||
			!("bashId" in diagnostic) ||
			typeof diagnostic.bashId !== "string"
		) {
			throw new TypeError("Expected a persisted terminal lookup diagnostic");
		}
		expect(
			await transcript(
				"bash_output",
				bashArgs,
				{
					content: result.content,
					details: { bashOutputError: { kind: diagnostic.kind, bashId: diagnostic.bashId } },
					isError: result.isError,
				},
				{ density, expanded: true, width: wide },
			),
		).toEqual(
			rows(wide, " ╭─ ✗ bash 39 • session not found", " │ No terminal session found with id: bash_39", " ╰─"),
		);
	});

	it("preserves unfamiliar output without asserting a successful lookup", async () => {
		expect(
			await transcript("bash_output", bashArgs, text("legacy output"), { density, expanded: true, width: wide }),
		).toEqual(rows(wide, " ╭─ ❯ bash 39", " │ legacy output", " ╰─"));
	});

	it("uses only the original header slot for a saved lookup without typed details", async () => {
		const result = text("status: running\n  older output\nstatus: killed");
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash 39 • running", " │   older output", " │ status: killed", " ╰─"),
		);
	});
});

it("keeps the first terminal completion across prose and hides its unchanged empty repeat", async () => {
	const args = { bash_id: "bash_39" };
	const completion = bashOutput("status: completed\n(no new output)", "bash_39", "completed", 0);
	const history = [
		...bashHistory([{ id: "first", sessionId: args.bash_id, result: completion }]),
		fauxAssistantMessage("The job is still complete.", { timestamp: 1 }),
		...bashHistory([{ id: "repeat", sessionId: args.bash_id, result: completion }]),
	];
	const rendered = await transcriptHistory(history, { density: "compact", expanded: true, width: wide });
	const output = rendered.join("\n");
	expect(output.match(/no new output/g)).toHaveLength(1);
	expect(output).toContain("The job is still complete.");
});

it("deduplicates identical empty polls but retains changed notices and widget views", async () => {
	const sessionId = "bash_39";
	const first = bashOutput(
		"monitor muted\nstatus: completed\n(no new output)",
		sessionId,
		"completed",
		0,
		"monitor muted",
	);
	const changedNotice = bashOutput(
		"monitor muted\nstatus: completed\n(no new output)",
		sessionId,
		"completed",
		0,
		"monitor muted",
		undefined,
		"log",
		undefined,
		5,
	);
	const widget = (title: string, updatedAtMs: number): JobWidgetFixture => ({
		id: sessionId,
		kind: "bash",
		state: "live",
		view: { title, headline: { text: "running" }, blocks: [] },
		updatedAtMs,
	});
	const widgetPoll = (title: string, updatedAtMs: number) =>
		bashOutput(
			"status: completed\n(no new output)",
			sessionId,
			"completed",
			0,
			"",
			undefined,
			"log",
			widget(title, updatedAtMs),
		);
	const history = bashHistory([
		{ id: "notice-1", sessionId, result: first },
		{ id: "notice-2", sessionId, result: changedNotice },
		{ id: "notice-repeat", sessionId, result: first },
		{ id: "widget-1", sessionId, result: widgetPoll("first widget", 0) },
		{ id: "widget-2", sessionId, result: widgetPoll("second widget", 1) },
		{ id: "widget-repeat", sessionId, result: widgetPoll("first widget", 2) },
	]);
	const output = (await transcriptHistory(history, { density: "grouped", expanded: true, width: wide })).join("\n");
	expect(output.match(/monitor muted/g)).toHaveLength(2);
	expect(output).toContain("5 lines dropped");
	expect(output.match(/first widget/g)).toHaveLength(1);
	expect(output).toContain("second widget");
});

it("preserves interleaved sessions and deduplicates an A/B/A poll run", async () => {
	const history = bashHistory([
		{ id: "a1", sessionId: "bash_39", result: bashOutput("status: running\nalpha", "bash_39", "running", null) },
		{ id: "b", sessionId: "bash_40", result: bashOutput("status: running\nbeta", "bash_40", "running", null) },
		{ id: "a2", sessionId: "bash_39", result: bashOutput("status: running\nalpha", "bash_39", "running", null) },
	]);
	const rendered = await transcriptHistory(history, { density: "grouped", expanded: true, width: wide });
	const output = rendered.join("\n");
	expect(output.match(/alpha/g)).toHaveLength(1);
	expect(output.match(/beta/g)).toHaveLength(1);
	expect(output).toContain("├─ ✓ bash 40 • running");
	expect(output.indexOf("alpha")).toBeLessThan(output.indexOf("beta"));
});

it("resets a session's duplicate interval after a hidden running transition", async () => {
	const history = bashHistory([
		{ id: "before", sessionId: "bash_39", result: bashOutput("status: completed\nalpha", "bash_39", "completed", 0) },
		{
			id: "running",
			sessionId: "bash_39",
			result: bashOutput("status: running\n(no new output)", "bash_39", "running", null),
		},
		{ id: "after", sessionId: "bash_39", result: bashOutput("status: completed\nalpha", "bash_39", "completed", 0) },
	]);
	const rendered = await transcriptHistory(history, { density: "grouped", expanded: true, width: wide });
	expect(rendered.join("\n").match(/alpha/g)).toHaveLength(2);
});

it("keeps every wide session ID and summarizes overflow before a mixed outcome", async () => {
	const calls = ["bash_111", "bash_222", "bash_333", "bash_444"].map((sessionId, index) => ({
		id: `id-${index}`,
		sessionId,
		result: bashOutput(
			`status: ${index === 0 ? "exited_1" : index === 1 ? "exited_2" : "completed"}\nresult-${index}`,
			sessionId,
			index === 0 ? "exited_1" : index === 1 ? "exited_2" : "completed",
			index === 0 ? 1 : index === 1 ? 2 : 0,
		),
	}));
	const wideOutput = (
		await transcriptHistory(bashHistory(calls), { density: "compact", expanded: false, width: wide })
	).join("\n");
	expect(wideOutput).toContain("~ bash 111 222 333 444");
	expect(wideOutput).toContain("~");
	expect(wideOutput).not.toContain("+");

	const narrowOutput = (
		await transcriptHistory(bashHistory(calls), { density: "compact", expanded: false, width: 23 })
	).join("\n");
	expect(narrowOutput).toContain("~");
	expect(narrowOutput).toContain("+2");

	const expandedOutput = (
		await transcriptHistory(bashHistory(calls.slice(0, 2)), { density: "grouped", expanded: true, width: wide })
	).join("\n");
	expect(expandedOutput).toContain("╭─ × bash 111");
	expect(expandedOutput).toContain("├─ × bash 222");
	expect(expandedOutput).not.toContain("cancelled");
});

it("keeps screen polls and missing metadata separate from log runs", async () => {
	const calls = [
		{
			id: "before",
			sessionId: "bash_39",
			result: bashOutput("status: completed\nbefore", "bash_39", "completed", 0),
		},
		{
			id: "screen",
			sessionId: "bash_39",
			view: "screen" as const,
			result: bashOutput("status: running\nscreen row", "bash_39", "running", null, "", undefined, "screen"),
		},
		{ id: "after", sessionId: "bash_40", result: bashOutput("status: completed\nafter", "bash_40", "completed", 0) },
		{ id: "legacy", sessionId: "bash_40", result: text("legacy output") },
	];
	const rendered = (
		await transcriptHistory(bashHistory(calls), { density: "grouped", expanded: true, width: wide })
	).join("\n");
	expect(rendered).toContain("screen row");
	expect(rendered).toContain("legacy output");
	expect(rendered).not.toContain("bash 39, 40");
});

it("keeps filtered running placeholders hidden and preserves child runtime identities", async () => {
	const calls = [
		{
			id: "filtered",
			sessionId: "bash_39",
			filter: "no-match",
			result: bashOutput("status: running\n(no new output)", "bash_39", "running", null, "", "filtered"),
		},
		{
			id: "child-one",
			sessionId: "bash_c1_2",
			result: bashOutput("status: completed\none", "bash_c1_2", "completed", 0),
		},
		{
			id: "child-two",
			sessionId: "bash_c2_2",
			result: bashOutput("status: completed\ntwo", "bash_c2_2", "completed", 0),
		},
	];
	const rendered = (
		await transcriptHistory(bashHistory(calls), { density: "compact", expanded: false, width: wide })
	).join("\n");
	expect(rendered).toContain("bash c1/2 c2/2");
	expect(rendered).not.toContain("no matching output");
});

describe.each(densities)("bash kill in %s", (density) => {
	it("renders the successful kill title and keeps the original result on replay", async () => {
		const result = text("bash_id: bash_39\nKilled bash_39.\nworker output");
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: false, width: wide })).toEqual(
			rows(wide, " ╶─ ✓ bash 39 • killed"),
		);
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash 39 • killed", " │ worker output", " ╰─"),
		);
	});

	it("shows a failed status and preserves the terminal error on replay", async () => {
		const result = { ...text("bash_id: bash_39\nCould not kill bash_39: session already exited."), isError: true };
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: false, width: wide })).toEqual(
			rows(wide, " ╶─ ✗ bash 39 • already exited"),
		);
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✗ bash 39 • already exited", " │ Could not kill bash_39: session already exited.", " ╰─"),
		);
	});

	it("puts the lowercase acknowledgment inside an otherwise empty kill card", async () => {
		const result = text("bash_id: bash_39\nKilled bash_39.");
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash 39 • killed", " │ killed bash_39.", " ╰─"),
		);
	});

	it("keeps non-standalone session-id text when rendering useful output", async () => {
		const result = text("worker bash_id: bash_39 finished");
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash 39 • killed", " │ worker bash_id: bash_39 finished", " ╰─"),
		);
	});

	it("does not invent a success acknowledgment for an empty failure", async () => {
		const result = { ...text(""), isError: true };
		expect(await transcript("kill_bash", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✗ bash 39 • failed", " ╰─"),
		);
	});
});

it("renders monitor notices separately from output", async () => {
	const result = bashOutput(
		"monitor muted; rearm to resume\nstatus: running\nscreen row",
		"bash_39",
		"running",
		null,
		"monitor muted; rearm to resume",
	);
	expect(
		await transcript("bash_output", bashArgs, result, { density: "grouped", expanded: true, width: wide }),
	).toEqual(rows(wide, " ╭─ ✓ bash 39 • running · monitor muted", " │ screen row", " ╰─"));
});

describe.each(densities)("catalog tool search in %s", (density) => {
	it("reveals the count and actual results with their schema", async () => {
		const args = { query: "weather" };
		const result = await catalogResult(args);
		expect(await transcript("tool_search", args, result, { density, expanded: false, width: wide })).toEqual(
			rows(wide, ' ╶─ ◉ tool • "weather"'),
		);
		expect(await transcript("tool_search", args, result, { density, expanded: true, width: wide })).toEqual(
			rows(
				wide,
				' ╭─ ◉ tool • "weather"',
				" │ 1 tool(s) found",
				' │ Found 1 tool(s) matching "weather". Nothing was activated;',
				" │ call one by name and it activates on that first call:",
				" │ ",
				" │ - weather - Local weather",
				' │   parameters: {"type":"object","properties":{}}',
				" ╰─",
			),
		);
	});

	it("truncates only the title and keeps the diagnostic on failure", async () => {
		const width = 32;
		const args = { query: "weather observation and forecast" };
		const result = { ...text("Catalog blocked\n  Retry later"), isError: true };
		expect(await transcript("tool_search", args, result, { density, expanded: false, width })).toEqual(
			rows(width, ' ╶─ ✗ tool • "weather observa…'),
		);
		expect(await transcript("tool_search", args, result, { density, expanded: true, width })).toEqual(
			rows(width, ' ╭─ ✗ tool • "weather observati…', " │ Catalog blocked", " │   Retry later", " ╰─"),
		);
	});
});

it("uses a real zero count on successful search, not an error icon", async () => {
	const args = { query: "teleportation" };
	expect(
		await transcript("tool_search", args, await catalogResult(args), {
			density: "grouped",
			expanded: true,
			width: wide,
		}),
	).toEqual(
		rows(
			wide,
			' ╭─ ◉ tool • "teleportation"',
			" │ 0 tool(s) found",
			' │ No catalog tools matched "teleportation". Your active tool',
			" │ set is unchanged. Try different keywords or a broader query.",
			" ╰─",
		),
	);
});

async function catalogResult(args: { readonly query: string }): Promise<Result> {
	const harness = await createHarness({ extensionFactories: catalogExtensions });
	try {
		await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Search for a catalog tool");
		const result = harness.session.agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "tool_search",
		);
		if (result?.role !== "toolResult") throw new TypeError("Expected tool search result");
		return result;
	} finally {
		harness.cleanup();
	}
}

it("keeps the Default bash output call, status and output rows", async () => {
	expect(
		await transcript("bash_output", bashArgs, text("status: running\n(no new output)"), {
			density: "default",
			expanded: true,
			width: wide,
		}),
	).toEqual(rows(wide, " bash_output bash_39", " status: running", " (no new output)"));
});

it("keeps kill-all on the Default tool result renderer", async () => {
	const output = "Killed 2 session(s).";
	const rendered = await transcript("kill_bash", { all: true }, text(output), {
		density: "default",
		expanded: true,
		width: wide,
	});
	expect(rendered.join("\n")).toContain("kill_bash");
	expect(rendered.join("\n")).toContain(output);
	expect(rendered.join("\n")).not.toContain("bash 39");
});
