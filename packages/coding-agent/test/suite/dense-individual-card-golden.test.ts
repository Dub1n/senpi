import {
	type AssistantMessage,
	fauxAssistantMessage,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { TodoToolDetails } from "../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { InlineExtension } from "../../src/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	densities,
	type Density,
	expandedSearchGolden,
	readGolden,
	searchGolden,
	todoGolden,
	width,
} from "./dense-individual-card-golden.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

type Replay = readonly (AssistantMessage | ToolResultMessage)[];
type CardView = "folded" | "expanded";
type SearchSourceFixture = { readonly title?: string; readonly url?: string; readonly snippet?: string };
type SearchActionFixture = {
	readonly query?: string;
	readonly queries?: readonly string[];
	readonly sources?: readonly SearchSourceFixture[];
};

async function visibleRows(
	replay: Replay,
	layout: { readonly density: Density | "default"; readonly view: CardView },
	extensions: InlineExtension[] = [],
	renderWidth = width,
): Promise<readonly string[]> {
	const surface = await explorationSurface(true, extensions);
	try {
		if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
			throw new TypeError("Expected the real exploration transcript");
		}
		invoke(surface.mode, "renderSessionItems", replay);
		surface.chat.setToolDisplayDensity(layout.density);
		invoke(surface.mode, "setToolsExpanded", layout.view === "expanded");
		return surface.chat.render(renderWidth).map(stripTerminalSequences);
	} finally {
		surface.cleanup();
	}
}

function toolReplay(
	name: string,
	args: ToolCall["arguments"],
	result: Pick<ToolResultMessage, "content" | "isError" | "details">,
): Replay {
	const id = `golden-${name}`;
	return [
		fauxAssistantMessage({ type: "toolCall", id, name, arguments: args }, { stopReason: "toolUse", timestamp: 0 }),
		{ ...result, role: "toolResult", toolName: name, toolCallId: id, timestamp: 0 },
	];
}

const todoInitDetails = {
	op: "init",
	storage: "session",
	ask: { entryId: "golden-ask", text: "Check the runtime before reporting.", capturedAt: 0 },
	phases: [
		{
			name: "Verification",
			tasks: [
				{ content: "Verify the runtime", status: "in_progress" },
				{ content: "Record the result", status: "pending" },
			],
		},
	],
} satisfies TodoToolDetails;

const todoDoneDetails = {
	...todoInitDetails,
	op: "done",
	phases: [
		{
			name: "Verification",
			tasks: [
				{ content: "Verify the runtime", status: "completed" },
				{ content: "Record the result", status: "in_progress" },
			],
		},
	],
	completedTasks: [{ phase: "Verification", content: "Verify the runtime" }],
} satisfies TodoToolDetails;

const todoCases = [
	{
		name: "init",
		replay: toolReplay(
			"todo",
			{ op: "init", list: [{ phase: "Verification", items: ["Verify the runtime", "Record the result"] }] },
			{ isError: false, content: [], details: todoInitDetails },
		),
	},
	{
		name: "done",
		replay: toolReplay(
			"todo",
			{ op: "done", task: "Verify the runtime" },
			{ isError: false, content: [], details: todoDoneDetails },
		),
	},
	{
		name: "failure",
		replay: toolReplay(
			"todo",
			{ op: "done", task: "Verify the runtime" },
			{ isError: true, content: [{ type: "text", text: 'Errors: Task "Verify the runtime" not found' }] },
		),
	},
] as const;

const views = ["folded", "expanded"] as const;
const todoView = toolReplay("todo", {}, { isError: false, content: [], details: { ...todoInitDetails, op: "view" } });

it("keeps a successful Todo view and its checklist available in Default", async () => {
	const visible = await visibleRows(todoView, { density: "default", view: "expanded" }, [todotoolsExtension]);
	expect(visible.join("\n")).toContain("Verify the runtime");
});

function searchReplay(status?: string, action?: SearchActionFixture): Replay {
	const searchAction = action ?? {
		queries: ["terminal rows", "render padding"],
		sources: [
			{
				title: "Terminal guide",
				url: "https://example.test/guide",
				snippet: "A guide to rendering rows.",
			},
		],
	};
	return [
		{
			...fauxAssistantMessage(
				{
					type: "providerNative",
					subtype: "web_search_call",
					raw: {
						...(status === undefined ? {} : { status }),
						action: searchAction,
					},
				},
				{ timestamp: 0 },
			),
			provider: "chatgpt-subscription",
		},
	];
}

const searchCases = [
	{ name: "completed", status: "completed" },
	{ name: "failed", status: "failed" },
	{ name: "unfamiliar", status: "awaiting_index" },
	{ name: "absent", status: undefined },
] as const;

describe.each(densities)("%s individual card goldens", (density) => {
	it("omits a confirmed Todo view without leaving a spacer", async () => {
		expect(await visibleRows(todoView, { density, view: "expanded" }, [todotoolsExtension])).toEqual([]);
	});

	it("retains a failed Todo view and its diagnostic", async () => {
		const replay = toolReplay(
			"todo",
			{ op: "view" },
			{ isError: true, content: [{ type: "text", text: "Cannot read checklist" }] },
		);
		expect(await visibleRows(replay, { density, view: "expanded" }, [todotoolsExtension])).toEqual([
			"",
			...["", " ╭─ ✗ todo • view", " │ Cannot read checklist", " ╰─", ""].map((line) => line.padEnd(width)),
		]);
	});
	describe.each(todoCases)("Todo $name", ({ name, replay }) => {
		it.each(views)("matches the complete %s action card", async (view) => {
			expect(await visibleRows(replay, { density, view }, [todotoolsExtension])).toEqual(todoGolden[name][view]);
		});
	});

	it.each([
		{ op: "done", status: "completed", struck: true },
		{ op: "drop", status: "abandoned", struck: false },
	] as const)("styles the $status Todo description in the folded heading", async ({ op, status, struck }) => {
		const details = {
			...todoInitDetails,
			op,
			phases: [{ name: "Verification", tasks: [{ content: "Verify the runtime", status }] }],
		} satisfies TodoToolDetails;
		const surface = await explorationSurface(true, [todotoolsExtension]);
		const terminal = new xterm.Terminal({ cols: width + 1, rows: 10, allowProposedApi: true });
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			invoke(
				surface.mode,
				"renderSessionItems",
				toolReplay(
					"todo",
					{ op, task: "Verify the runtime" },
					{
						isError: false,
						content: [],
						details,
					},
				),
			);
			surface.chat.setToolDisplayDensity(density);
			const rows = surface.chat.render(width);
			await new Promise<void>((resolve) => terminal.write(rows.join("\x1b[0m\r\n"), resolve));
			const row = rows.findIndex((line) => stripTerminalSequences(line).includes("Verify the runtime"));
			const column = stripTerminalSequences(rows[row] ?? "").indexOf("Verify the runtime");
			const cell = terminal.buffer.active.getLine(row)?.getCell(column);
			expect(cell).toBeDefined();
			expect(Boolean(cell?.isStrikethrough())).toBe(struck);
			expect(Boolean(cell?.isItalic())).toBe(false);
		} finally {
			terminal.dispose();
			surface.cleanup();
		}
	});

	it.each(views)("matches the complete %s read card for an indented slice with blank boundaries", async (view) => {
		const replay = toolReplay(
			"read",
			{ path: "scripts/dev-window.mjs", offset: 40, limit: 3 },
			{ isError: false, content: [{ type: "text", text: "\n    const ready = true;\n" }] },
		);

		expect(await visibleRows(replay, { density, view })).toEqual(readGolden[view]);
	});

	it("trims only trailing whitespace rows from an expanded read", async () => {
		const replay = toolReplay(
			"read",
			{ path: "sample.txt" },
			{
				isError: false,
				content: [{ type: "text", text: "\n  first\n \n    second\n  \n\t" }],
			},
		);
		expect(await visibleRows(replay, { density, view: "expanded" })).toEqual([
			"",
			...["", " ╭─ ✓ read • sample.txt", " │ ", " │   first", " │  ", " │     second", " ╰─", ""].map((line) =>
				line.padEnd(width),
			),
		]);
	});

	it.each(searchCases)("matches the folded provider search with $name status", async ({ name, status }) => {
		expect(await visibleRows(searchReplay(status), { density, view: "folded" })).toEqual(searchGolden[name][density]);
	});

	it("aligns expanded provider status, queries and sources while preserving snippet indentation", async () => {
		expect(await visibleRows(searchReplay("completed"), { density, view: "expanded" })).toEqual(
			expandedSearchGolden[density],
		);
	});

	it("uses the query as the heading when a search has no sources", async () => {
		const rows = await visibleRows(searchReplay("completed", { query: "native query", sources: [] }), {
			density,
			view: "expanded",
		});
		const rendered = rows.join("\n");
		expect(rendered).toContain('search • "native query"');
		expect(rendered).toContain("chatgpt-subscription");
		expect(rendered).toContain("status: completed");
		expect(rendered.split('"native query"')).toHaveLength(2);
		expect(rendered).not.toContain("0 sources");
	});

	it.each([
		{ name: "absent", action: { sources: [] } },
		{ name: "empty", action: { query: "", queries: ["", "  "], sources: [] } },
	])("uses a native search fallback when the query is $name", async ({ action }) => {
		const rows = await visibleRows(searchReplay(undefined, action), { density, view: "expanded" });
		const rendered = rows.join("\n");
		expect(rendered).toContain("search • web_search");
		expect(rendered).toContain("chatgpt-subscription");
		expect(rendered).not.toContain("query:");
		expect(rendered).not.toContain('""');
	});

	it("keeps only distinct non-promoted queries in the body", async () => {
		const rows = await visibleRows(
			searchReplay(undefined, { queries: ["first query", "first query", "second query"], sources: [] }),
			{ density, view: "expanded" },
		);
		const rendered = rows.join("\n");
		expect(rendered).toContain('search • "first query"');
		expect(rendered).toContain('query: "second query"');
		expect(rendered.split('"first query"')).toHaveLength(2);
		expect(rendered.split('"second query"')).toHaveLength(2);
	});

	it("keeps the full promoted query in the body when a narrow expanded heading truncates it", async () => {
		const rows = await visibleRows(
			searchReplay("completed", { query: "terminal rows", sources: [] }),
			{ density, view: "expanded" },
			[],
			28,
		);
		const heading = rows.find((line) => line.includes("search •"));
		expect(heading).toContain("…");
		expect(rows.join("\n")).toContain('query: "terminal rows"');
	});

	it("styles the promoted query as muted italic terminal text", async () => {
		initTheme("dark");
		const surface = await explorationSurface(true);
		const terminal = new xterm.Terminal({ cols: width + 1, rows: 10, allowProposedApi: true });
		const mutedTerminal = new xterm.Terminal({ cols: width + 1, rows: 1, allowProposedApi: true });
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			invoke(surface.mode, "renderSessionItems", searchReplay("completed"));
			surface.chat.setToolDisplayDensity(density);
			const rows = surface.chat.render(width);
			await new Promise<void>((resolve) => terminal.write(rows.join("\x1b[0m\r\n"), resolve));
			await new Promise<void>((resolve) => mutedTerminal.write(theme.fg("muted", "M"), resolve));
			const row = rows.findIndex((line) => stripTerminalSequences(line).includes('"terminal rows"'));
			const column = stripTerminalSequences(rows[row] ?? "").indexOf('"terminal rows"');
			const first = terminal.buffer.active.getLine(row)?.getCell(column);
			const last = terminal.buffer.active.getLine(row)?.getCell(column + '"terminal rows"'.length - 1);
			expect(Boolean(first?.isItalic())).toBe(true);
			expect(Boolean(last?.isItalic())).toBe(true);
			expect(first?.getFgColor()).toBe(mutedTerminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor());
		} finally {
			mutedTerminal.dispose();
			terminal.dispose();
			surface.cleanup();
		}
	});
});
