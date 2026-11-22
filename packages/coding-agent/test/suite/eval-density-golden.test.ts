import type { AssistantMessage, JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createEvalTool } from "../../../senpi-codemode/src/tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "../../../senpi-codemode/src/tool/render.ts";
import type { InlineExtension } from "../../src/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
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
});
