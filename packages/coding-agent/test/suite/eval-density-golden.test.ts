import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TUI, visibleWidth } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { createEvalTool } from "../../../senpi-codemode/src/tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "../../../senpi-codemode/src/tool/render.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { InlineExtension } from "../../src/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolDensityRow } from "../../src/modes/interactive/components/tool-density-row.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";
import { evalDensityGolden } from "./eval-density-golden.ts";

const registerEvalRenderer: InlineExtension = (pi) => {
	pi.registerTool(
		createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: { getKernel: async () => Promise.reject(new Error("render replay does not execute cells")) },
			cellTimeoutSeconds: 30,
			executeTool: async () => ({ content: [], details: {} }),
			renderers: { renderCall: renderEvalCall, renderResult: renderEvalResult },
		}),
	);
};

function evalReplay(): { readonly assistant: AssistantMessage; readonly result: ToolResultMessage } {
	const assistant: AssistantMessage = {
		...fauxAssistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "density-eval",
				name: "eval",
				arguments: {
					language: "js",
					code: "print(result.text);",
					summary: "Review the changed eval density renderer through session replay",
				},
			},
		],
		stopReason: "toolUse",
	};
	const details: JsonObject = {
		language: "js",
		runtime: { name: "bun", version: "1.4.4", path: "/opt/bun/bin/omo" },
		summary: "Review the changed eval density renderer through session replay",
		durationMs: 550,
		wallDurationMs: 550,
		toolCallCount: 1,
		toolCalls: [
			{
				name: "bash",
				ok: true,
				args: { command: "git status --short" },
				durationMs: 550,
				resultPreview: "M viewer.ts",
			},
		],
		truncated: false,
		cells: [
			{
				index: 0,
				summary: "Review the changed eval density renderer through session replay",
				code: "print(result.text);",
				language: "js",
				output: "M viewer.ts",
				status: "complete",
				durationMs: 550,
				runtime: { name: "bun", version: "1.4.4", path: "/opt/bun/bin/omo" },
			},
		],
	};
	return {
		assistant,
		result: {
			role: "toolResult",
			toolName: "eval",
			toolCallId: "density-eval",
			content: [{ type: "text", text: "M viewer.ts" }],
			isError: false,
			details,
			timestamp: 0,
		},
	};
}

function paddedRow(content: string, width: number): string {
	return content + " ".repeat(Math.max(0, width - visibleWidth(content)));
}

function foldedBlock(lines: readonly string[], title: string): string[] {
	const titleIndex = lines.findIndex((line) => line.includes(title));
	return lines.slice(titleIndex - 2, titleIndex + 2);
}

function expandedBlock(lines: readonly string[], width: number): string[] {
	const titleIndex = lines.findIndex((line) => line.includes("╭─"));
	const closing = paddedRow(" ╰─", width);
	const closingIndex = lines.findIndex((line, index) => index >= titleIndex && line === closing);
	return lines.slice(titleIndex - 2, closingIndex + 2);
}

function expectPaddedRows(lines: readonly string[], width: number): void {
	for (const line of lines.slice(1)) expect(visibleWidth(line)).toBe(width);
}

describe("Grouped eval density golden", () => {
	it.each([
		{
			args: { language: "js", code: "print(1)", summary: "Inspect the result" },
			title: "Inspect the result",
			body: [" │ eval js", " │ print(1)"],
		},
		{ args: { language: "js", code: "print(1)" }, title: "eval js", body: [" │ eval js", " │ print(1)"] },
		{ args: {}, title: "eval", body: [" │ ..."] },
		{ args: { action: "list" }, title: "eval list", body: [] },
		{ args: { action: "peek", cell_id: "cell-a" }, title: "eval peek cell-a", body: [] },
		{ args: { action: "stop", cell_id: "cell-b" }, title: "eval stop cell-b", body: [] },
	])("renders structured pending and running calls for $title", ({ args, title, body }) => {
		initTheme("dark");
		const ui = new TUI(new VirtualTerminal());
		const card = new ToolExecutionComponent(
			"eval",
			"pending-eval",
			args,
			{},
			{ renderShell: "self", renderCall: renderEvalCall, renderResult: renderEvalResult },
			ui,
			process.cwd(),
		);
		try {
			const row = new ToolDensityRow(
				card,
				() => {},
				() => ({ colorFrames: true, colorNames: true, colorIcons: true }),
			);
			row.setLayout(true, true, true);
			expect(card.renderDensityCard(80, { grouped: true })?.format).toBe("structured");
			expect(row.render(80).map(stripTerminalSequences)).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(` ╶─ ○ ${title} ${title === "Inspect the result" ? "·" : "•"} pending`, 80),
				paddedRow("", 80),
			]);
			card.markExecutionStarted();
			expect(row.render(80).map(stripTerminalSequences)).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(` ╶─ ○ ${title}`, 80),
				paddedRow("", 80),
			]);
			card.setExpanded(true);
			expect(row.render(80).map(stripTerminalSequences)).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(` ╭─ ○ ${title}`, 80),
				...body.map((line) => paddedRow(line, 80)),
				paddedRow(" ╰─", 80),
				paddedRow("", 80),
			]);
		} finally {
			card.dispose();
			ui.stop();
		}
	});

	it("replays the real eval renderer folded and expanded at wide and narrow widths", async () => {
		const surface = await explorationSurface(true, [registerEvalRenderer]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
				throw new TypeError("Expected the real exploration transcript");
			}
			const { assistant, result } = evalReplay();
			invoke(surface.mode, "renderSessionItems", [assistant, result]);
			surface.chat.setToolDisplayDensity("grouped");

			const wideFolded = surface.chat.render(evalDensityGolden.wide.width).map(stripTerminalSequences);
			const wideFoldedBlock = foldedBlock(wideFolded, "Review the changed eval density renderer");
			expect(wideFoldedBlock).toEqual([
				"",
				paddedRow("", evalDensityGolden.wide.width),
				paddedRow(evalDensityGolden.wide.folded, evalDensityGolden.wide.width),
				paddedRow("", evalDensityGolden.wide.width),
			]);
			expectPaddedRows(wideFoldedBlock, evalDensityGolden.wide.width);

			invoke(surface.mode, "setToolsExpanded", true);
			const wideExpanded = surface.chat.render(evalDensityGolden.wide.width).map(stripTerminalSequences);
			const wideExpandedBlock = expandedBlock(wideExpanded, evalDensityGolden.wide.width);
			expect(wideExpandedBlock).toEqual([
				"",
				paddedRow("", evalDensityGolden.wide.width),
				...evalDensityGolden.wide.expanded.map((line) => paddedRow(line, evalDensityGolden.wide.width)),
				paddedRow("", evalDensityGolden.wide.width),
			]);
			expectPaddedRows(wideExpandedBlock, evalDensityGolden.wide.width);

			invoke(surface.mode, "setToolsExpanded", false);
			const narrowFolded = surface.chat.render(evalDensityGolden.narrow.width).map(stripTerminalSequences);
			const narrowFoldedBlock = foldedBlock(narrowFolded, "Review the changed eval density");
			expect(narrowFoldedBlock).toEqual([
				"",
				paddedRow("", evalDensityGolden.narrow.width),
				paddedRow(evalDensityGolden.narrow.folded, evalDensityGolden.narrow.width),
				paddedRow("", evalDensityGolden.narrow.width),
			]);
			expectPaddedRows(narrowFoldedBlock, evalDensityGolden.narrow.width);

			invoke(surface.mode, "setToolsExpanded", true);
			const narrowExpanded = surface.chat.render(evalDensityGolden.narrow.width).map(stripTerminalSequences);
			const narrowExpandedBlock = expandedBlock(narrowExpanded, evalDensityGolden.narrow.width);
			expect(narrowExpandedBlock).toEqual([
				"",
				paddedRow("", evalDensityGolden.narrow.width),
				...evalDensityGolden.narrow.expanded.map((line) => paddedRow(line, evalDensityGolden.narrow.width)),
				paddedRow("", evalDensityGolden.narrow.width),
			]);
			expectPaddedRows(narrowExpandedBlock, evalDensityGolden.narrow.width);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps completed list counts in grouped rows and Default list output", async () => {
		const surface = await explorationSurface(true, [registerEvalRenderer]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
				throw new TypeError("Expected the real exploration transcript");
			}
			const assistant: AssistantMessage = {
				...fauxAssistantMessage(""),
				content: [{ type: "toolCall", id: "list-eval", name: "eval", arguments: { action: "list" } }],
				stopReason: "toolUse",
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolName: "eval",
				toolCallId: "list-eval",
				content: [{ type: "text", text: "cell-a completed" }],
				isError: false,
				details: {
					action: "list",
					cells: [{ cellId: "cell-a", language: "js", state: "completed", startedAtMs: 0 }],
				},
				timestamp: 0,
			};
			invoke(surface.mode, "renderSessionItems", [assistant, result]);
			surface.chat.setToolDisplayDensity("grouped");
			const folded = surface.chat.render(80).map(stripTerminalSequences);
			expect(foldedBlock(folded, "eval list")).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(" ╶─ ✓ eval list • 1 completed cell", 80),
				paddedRow("", 80),
			]);
			invoke(surface.mode, "setToolsExpanded", true);
			const expanded = surface.chat.render(80).map(stripTerminalSequences);
			expect(expandedBlock(expanded, 80)).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(" ╭─ ✓ eval list", 80),
				paddedRow(" │ cell-a completed", 80),
				paddedRow(" ╰─", 80),
				paddedRow("", 80),
			]);

			surface.chat.setToolDisplayDensity("default");
			const defaultRows = surface.chat.render(80).map(stripTerminalSequences);
			const listIndex = defaultRows.findIndex((line) => line.includes("eval list"));
			expect(defaultRows.slice(listIndex, listIndex + 2).map((line) => line.trimEnd())).toEqual([
				" eval list",
				" cell-a completed",
			]);
		} finally {
			surface.cleanup();
		}
	});

	it("renders a host failure without inventing a description", async () => {
		const surface = await explorationSurface(true, [registerEvalRenderer]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
				throw new TypeError("Expected the real exploration transcript");
			}
			const assistant: AssistantMessage = {
				...fauxAssistantMessage(""),
				content: [
					{
						type: "toolCall",
						id: "failed-eval",
						name: "eval",
						arguments: { language: "js", code: "throw Error()" },
					},
				],
				stopReason: "toolUse",
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolName: "eval",
				toolCallId: "failed-eval",
				content: [{ type: "text", text: "kernel unavailable" }],
				isError: true,
				timestamp: 0,
			};
			invoke(surface.mode, "renderSessionItems", [assistant, result]);
			surface.chat.setToolDisplayDensity("grouped");
			surface.chat.setToolDisplayColors({ colorFrames: true, colorNames: true, colorIcons: true });
			const folded = surface.chat.render(80).map(stripTerminalSequences);
			expect(foldedBlock(folded, "eval js")).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(" ╶─ ✗ eval js", 80),
				paddedRow("", 80),
			]);
			invoke(surface.mode, "setToolsExpanded", true);
			const expandedAnsi = surface.chat.render(80);
			const expanded = expandedAnsi.map(stripTerminalSequences);
			expect(expandedBlock(expanded, 80)).toEqual([
				"",
				paddedRow("", 80),
				paddedRow(" ╭─ ✗ eval js", 80),
				paddedRow(" │ eval js", 80),
				paddedRow(" ├─ output", 80),
				paddedRow(" │ kernel unavailable", 80),
				paddedRow(" ╰─", 80),
				paddedRow("", 80),
			]);
			const terminal = new xterm.Terminal({ cols: 81, rows: expandedAnsi.length + 1, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) => terminal.write(expandedAnsi.join("\x1b[0m\r\n"), resolve));
				const headingRow = expanded.findIndex((line) => line.includes("╭─ ✗ eval js"));
				const outputRow = expanded.findIndex((line) => line.includes("├─ output"));
				const titleCell = terminal.buffer.active.getLine(headingRow)?.getCell(6);
				const outputCell = terminal.buffer.active.getLine(outputRow)?.getCell(4);
				expect(titleCell).toBeDefined();
				expect(outputCell).toBeDefined();
				expect([outputCell?.getFgColorMode(), outputCell?.getFgColor(), outputCell?.isBold()]).toEqual([
					titleCell?.getFgColorMode(),
					titleCell?.getFgColor(),
					titleCell?.isBold(),
				]);
				expect(outputCell?.isBold()).not.toBe(0);
			} finally {
				terminal.dispose();
			}
		} finally {
			surface.cleanup();
		}
	});
});
