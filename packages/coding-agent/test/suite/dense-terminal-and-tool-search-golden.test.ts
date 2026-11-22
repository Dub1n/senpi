import { fauxAssistantMessage, fauxToolCall, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { invoke } from "./exploration-surface-harness.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";

const wide = 64;
const densities = ["compact", "grouped"] as const;
type Density = "default" | (typeof densities)[number];
type ToolName = "bash_output" | "tool_search";
type Result = Pick<ToolResultMessage, "content" | "details"> & { readonly isError?: boolean | undefined };

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
	const harness = await createHarness({
		settings: { smoothStreaming: false, hideThinkingBlock: true },
		extensionFactories:
			name === "tool_search"
				? catalogExtensions
				: [{ name: "density-terminal", factory: (pi) => pi.registerTool(terminalTool) }],
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
		if (name === "tool_search") {
			await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		}
		invoke(mode, "renderSessionItems", [
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
		]);
		chat.setToolDisplayDensity(layout.density);
		invoke(mode, "setToolsExpanded", layout.expanded);
		return chat.render(layout.width).map(stripTerminalSequences);
	} finally {
		if (chat instanceof ExplorationTranscriptContainer) chat.dispose();
		ui.stop();
		harness.cleanup();
	}
}

const terminalTool = createBashOutputTool({
	cwd: "/workspace",
	defaultCols: 80,
	defaultRows: 24,
	getEnv: () => ({}),
	manager: new TerminalManager(),
});
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
): Result {
	const statusStart = notice ? notice.length + 1 : 0;
	const statusEnd = value.indexOf("\n", statusStart);
	return {
		...text(value),
		details: {
			bashOutput: { sessionId, processStatus, exitCode, statusStart, statusEnd },
		},
	};
}

describe.each(densities)("bash output in %s", (density) => {
	it("separates the successful lookup from the running process", async () => {
		const result = bashOutput("status: running\n(no new output)", "bash_39", "running", null);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: false, width: wide })).toEqual(
			rows(wide, " ╶─ ✓ bash 39 • running"),
		);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(wide, " ╭─ ✓ bash 39 • running", " │ (no new output)", " ╰─"),
		);
	});

	it("keeps failed exit status and shell payload distinct from a lookup failure", async () => {
		const result = bashOutput(
			"status: exited_3 exit_code: 3\n  kept indentation\n\nstatus: running",
			"bash_39",
			"exited_3",
			3,
		);
		expect(await transcript("bash_output", bashArgs, result, { density, expanded: true, width: wide })).toEqual(
			rows(
				wide,
				" ╭─ ✓ bash 39 • exited_3 · exit_code: 3",
				" │   kept indentation",
				" │ ",
				" │ status: running",
				" ╰─",
			),
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
		expect(
			await transcript(
				"bash_output",
				bashArgs,
				{ content: result.content, isError: result.isError },
				{ density, expanded: true, width: wide },
			),
		).toEqual(rows(wide, " ╭─ ✗ bash 39", " │ No terminal session found with id: bash_39", " ╰─"));
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
	).toEqual(rows(wide, " ╭─ ✓ bash 39 • running", " │ monitor muted; rearm to resume", " │ screen row", " ╰─"));
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
