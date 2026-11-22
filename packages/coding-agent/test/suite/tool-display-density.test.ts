import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Box, stripTerminalSequences, Text, TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const failedCommand = "command failed independently of the terminal";
const longSummary = "確認する".repeat(35);

async function fixture() {
	const surface = await explorationSurface();
	if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
		surface.cleanup();
		throw new TypeError("Expected the interactive transcript");
	}
	const message: AssistantMessage = {
		...fauxAssistantMessage(""),
		content: [
			{ type: "toolCall", id: "read", name: "read", arguments: { path: "fixture.txt" } },
			{ type: "toolCall", id: "eval", name: "eval", arguments: { action: "list" } },
			{ type: "text", text: "Assistant prose breaks the group." },
			{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "echo fixture" } },
			{ type: "toolCall", id: "run", name: "eval", arguments: { language: "js", summary: longSummary } },
		],
		stopReason: "toolUse",
	};
	const result = (
		toolName: string,
		toolCallId: string,
		text: string,
		details?: ToolResultMessage["details"],
	): ToolResultMessage => ({
		role: "toolResult",
		toolName,
		toolCallId,
		content: [{ type: "text", text }],
		isError: toolCallId === "bash",
		details,
		timestamp: 0,
	});
	invoke(surface.mode, "renderSessionItems", [
		message,
		result("read", "read", "FIXTURE_READ_CONTENT"),
		result("eval", "eval", "FIXTURE_EVAL_LIST_DETAILS", { action: "list", cells: [{ state: "completed" }] }),
		result("bash", "bash", failedCommand),
		result("eval", "run", "FIXTURE_EVAL_RUN_DETAILS"),
	]);
	return { ...surface, chat: surface.chat };
}

function rowIndices(lines: readonly string[]): number[] {
	return lines.flatMap((line, index) => (line.includes("╶─") ? [index] : []));
}

describe("tool display density", () => {
	it.each(["compact", "grouped"] as const)("keeps only the live hidden thinking indicator in %s", async (density) => {
		const surface = await explorationSurface();
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
				throw new TypeError("Expected the interactive transcript");
			}
			const live: AssistantMessage = {
				...fauxAssistantMessage(""),
				stopReason: "pending",
				content: [{ type: "thinking", thinking: "Fixture reasoning", startedAt: 1_000 }],
			};
			const done: AssistantMessage = {
				...live,
				stopReason: "stop",
				content: [{ type: "thinking", thinking: "Fixture reasoning", startedAt: 1_000, endedAt: 3_000 }],
			};
			const assistant = new AssistantMessageComponent(undefined, true);
			surface.chat.setToolDisplayDensity(density);
			surface.chat.addChild(assistant);
			assistant.updateContent(live, true);
			expect(surface.text(80)).toContain("Thinking...");
			expect(surface.text(80)).not.toContain("Fixture reasoning");

			assistant.updateContent(done, false);
			expect(surface.chat.render(80)).toEqual([]);

			surface.chat.setToolDisplayDensity("default");
			expect(surface.text(80)).toContain("Thought: 2.0s");

			surface.chat.setToolDisplayDensity(density);
			assistant.setHideThinkingBlock(false);
			expect(surface.text(80)).toContain("Thought: 2.0s");
			expect(surface.text(80)).toContain("Fixture reasoning");
			assistant.setHideThinkingBlock(true);
			expect(surface.chat.render(80)).toEqual([]);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("shows one row per call with %s spacing", async (density) => {
		const surface = await fixture();
		try {
			surface.chat.setToolDisplayDensity(density);
			const transcript = surface.text(100);
			const lines = transcript.split("\n");
			const [read, list, bash, run, ...extra] = rowIndices(lines);
			expect(extra).toEqual([]);
			expect(lines[read]).toContain("read");
			expect(lines[list]).toContain("1 completed cell");
			expect(lines[bash]).toContain("✗");
			expect(lines[run]).toContain("確認する");
			expect(list - read).toBe(density === "grouped" ? 1 : 4);
			expect(run - bash).toBe(density === "grouped" ? 1 : 4);
			expect(lines.slice(list + 1, bash).join("\n")).toContain("Assistant prose breaks the group.");
			expect(transcript).not.toContain("FIXTURE_EVAL_LIST_DETAILS");
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("pads and truncates long %s summaries", async (density) => {
		const surface = await fixture();
		try {
			surface.chat.setToolDisplayDensity(density);
			const width = 64;
			const row = surface.chat
				.render(width)
				.map(stripTerminalSequences)
				.find((line) => line.includes("確認する"));
			expect(row).toMatch(/^ ╶─.*….* {2}$/u);
			expect(visibleWidth(row?.trimEnd() ?? "")).toBeLessThanOrEqual(width - 2);
			expect(row).not.toContain("...");
			expect(visibleWidth(row ?? "")).toBe(width);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("toggles %s cards without capturing press", async (density) => {
		const surface = await fixture();
		try {
			surface.chat.setToolDisplayDensity(density);
			const width = 100;
			const collapsed = surface.text(width).split("\n");
			const bash = collapsed.findIndex((line) => line.includes("╶─") && line.includes("bash"));
			expect(bash).toBeGreaterThan(0);
			const mouse = (type: TuiMouseEvent["type"], y: number, height: number) =>
				surface.chat.handleMouse({
					type,
					button: "left",
					x: 6,
					y,
					screenX: 6,
					screenY: y,
					width,
					height,
					shift: false,
					alt: false,
					ctrl: false,
				});
			expect(mouse("press", bash, collapsed.length)).toBeUndefined();
			expect(mouse("click", bash, collapsed.length)?.handled).toBe(true);
			const expanded = surface.text(width).split("\n");
			expect(expanded).not.toContain(collapsed[bash]);
			const output = expanded.findIndex((line) => line.includes(failedCommand));
			expect(output).toBeGreaterThanOrEqual(bash);
			expect(mouse("press", output, expanded.length)).toBeUndefined();
			const neighbor = expanded.indexOf(collapsed[density === "grouped" ? bash + 1 : bash + 4]);
			if (density === "grouped") {
				expect(expanded[output + 1]).toMatch(/^\s*╰─\s*$/u);
				expect(neighbor).toBe(output + 2);
			} else expect(neighbor).toBeGreaterThan(output + 1);
			expect(mouse("click", output, expanded.length)?.handled).toBe(true);
			expect(surface.text(width).split("\n")).toEqual(collapsed);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a self-rendered card's color in Compact and shares the Grouped box", () => {
		const ui = new TUI(new VirtualTerminal(64, 30));
		const chat = new ExplorationTranscriptContainer({ tailBudget: 10, warmChunkSize: 10, requestRender: () => {} });
		const card = new ToolExecutionComponent(
			"fixture-memory",
			"memory",
			{},
			{},
			{
				renderShell: "self",
				renderCall: () => ({ render: () => [], invalidate() {} }),
				renderResult: () => {
					const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
					box.addChild(new Text("STORED_NOTE\nStored note detail", 0, 0));
					return box;
				},
			},
			ui,
			process.cwd(),
		);
		const neighbor = new ToolExecutionComponent("fixture-neighbor", "next", {}, {}, undefined, ui, process.cwd());
		const paintCode = (painted: string) => painted.split("probe")[0];
		const custom = paintCode(theme.bg("customMessageBg", "probe"));
		const standard = paintCode(theme.bg("toolSuccessBg", "probe"));
		try {
			chat.addChild(card);
			chat.addChild(neighbor);
			card.updateResult({ content: [], isError: false });
			neighbor.updateResult({ content: [], isError: false });
			chat.setToolDisplayDensity("compact");
			const collapsed = chat.render(64).find((line) => line.includes("fixture-memory"));
			expect(collapsed?.startsWith(custom)).toBe(true);
			chat.setToolDisplayDensity("grouped");
			// Exercise a cached self-render result as well as the first paint.
			card.setExpanded(true);
			card.render(64);
			const lines = chat.render(64);
			const title = lines.findIndex((line) => line.includes("STORED_NOTE"));
			expect(stripTerminalSequences(lines[title]).trim()).toBe("╭─ STORED_NOTE");
			expect(stripTerminalSequences(lines[title + 1]).trim()).toBe("│ Stored note detail");
			expect(stripTerminalSequences(lines[title + 2]).trim()).toBe("╰─");
			expect(lines[title + 3]).toContain("fixture-neighbor");
			for (const line of lines.slice(title - 1, title + 4)) expect(line.startsWith(standard)).toBe(true);
		} finally {
			chat.dispose();
		}
	});

	it("joins tool-only turns and breaks the run when their assistant head gains prose", () => {
		const ui = new TUI(new VirtualTerminal(64, 30));
		const chat = new ExplorationTranscriptContainer({ tailBudget: 10, warmChunkSize: 10, requestRender: () => {} });
		const head = new AssistantMessageComponent(fauxAssistantMessage(""));
		chat.addChild(new ToolExecutionComponent("read", "first", {}, {}, undefined, ui, process.cwd()));
		chat.addChild(head);
		chat.addChild(new ToolExecutionComponent("read", "second", {}, {}, undefined, ui, process.cwd()));
		chat.setToolDisplayDensity("grouped");
		try {
			const [first, second] = rowIndices(chat.render(64));
			expect(second - first).toBe(1);
			head.updateContent(fauxAssistantMessage("The next call starts a separate group."), true);
			const lines = chat.render(64);
			const [before, after] = rowIndices(lines);
			expect(after - before).toBeGreaterThan(1);
			expect(lines.slice(before + 1, after).join("\n")).toContain("The next call starts a separate group.");
		} finally {
			chat.dispose();
		}
	});

	it.each(["compact", "grouped"] as const)(
		"shows a self-shell tool failure in %s without rendering the original shell",
		(density) => {
			const ui = new TUI(new VirtualTerminal(64, 30));
			const chat = new ExplorationTranscriptContainer({ tailBudget: 2, warmChunkSize: 2, requestRender: () => {} });
			let detailRenders = 0;
			const renderEmpty = () => ({
				render() {
					detailRenders++;
					return [];
				},
				invalidate() {},
			});
			try {
				chat.setToolDisplayDensity(density);
				for (let i = 0; i < 8; i++) {
					const card = new ToolExecutionComponent(
						`shell-tool-${i}`,
						`shell-call-${i}`,
						{},
						{},
						{ renderShell: "self", renderCall: () => new Text("", 0, 0), renderResult: renderEmpty },
						ui,
						process.cwd(),
					);
					chat.addChild(card);
					card.updateResult({ content: [], isError: i === 7 });
				}
				const lines = chat.render(64);
				const rows = rowIndices(lines);
				expect(rows).toHaveLength(2);
				expect(lines[rows[1]]).toContain("shell-tool-7");
				expect(lines[rows[1]]).toContain("✗");
				expect(detailRenders).toBe(0);
			} finally {
				chat.dispose();
			}
		},
	);

	it("keeps failed and cancelled eval cells visible in a narrow mixed list", async () => {
		const surface = await explorationSurface();
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected the transcript");
			surface.chat.setToolDisplayDensity("grouped");
			await surface.event({
				type: "tool_execution_start",
				toolName: "eval",
				toolCallId: "mixed",
				args: { action: "list" },
			});
			await surface.event({
				type: "tool_execution_end",
				toolName: "eval",
				toolCallId: "mixed",
				isError: false,
				result: {
					content: [],
					details: {
						action: "list",
						cells: ["running", "queued", "completed", "failed", "cancelled"].map((state) => ({ state })),
					},
				},
			});
			const width = 32;
			const lines = surface.text(width).split("\n");
			const [row] = rowIndices(lines);
			expect(lines[row]).toContain("✗");
			expect(lines[row]).toContain("1 failed, 1 cancelled");
			expect(visibleWidth(lines[row])).toBeLessThanOrEqual(width);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps the error visible without wrapping at narrow widths", async () => {
		const surface = await fixture();
		try {
			surface.chat.setToolDisplayDensity("grouped");
			const width = 32;
			const lines = surface.text(width).split("\n");
			const rows = rowIndices(lines).map((index) => lines[index]);
			expect(rows).toHaveLength(4);
			expect(rows[2]).toContain("✗");
			expect(Math.max(...rows.map(visibleWidth))).toBeLessThanOrEqual(width);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("expands all %s cards without changing density", async (density) => {
		const surface = await fixture();
		try {
			surface.chat.setToolDisplayDensity(density);
			const collapsed = surface.text(100);
			invoke(surface.mode, "setToolsExpanded", true);
			const expanded = surface.text(100);
			expect(expanded).toContain("FIXTURE_EVAL_LIST_DETAILS");
			expect(expanded).toContain(failedCommand);
			expect(expanded).toMatch(/^ ╭─/mu);
			expect(rowIndices(expanded.split("\n"))).toEqual([]);
			invoke(surface.mode, "setToolsExpanded", false);
			expect(surface.text(100)).toBe(collapsed);
		} finally {
			surface.cleanup();
		}
	});
});
