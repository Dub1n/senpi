import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchResult,
} from "../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";

const repeated = file("/p/repeated.txt", "-1 before\n+1 after");
const middle = file("/p/middle.txt", "-1 middle-before\n+1 middle-after");
const appended = file("/p/appended.txt", "-1 appended-before\n+1 appended-after");

function file(filePath: string, diff: string): ApplyPatchPreviewFile {
	return { filePath, operation: "update", diff, added: 1, removed: 1 };
}

function patch(
	id: string,
	preview: ApplyPatchPreviewFile,
): [ReturnType<typeof fauxAssistantMessage>, ToolResultMessage] {
	const result: ApplyPatchResult = {
		summaries: [],
		appliedFiles: [preview.filePath],
		failures: [],
		hasPartialSuccess: false,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [] },
		details: { fuzz: 0, appliedOperations: [{ operationIndex: 0, preview }] },
	};
	return [
		fauxAssistantMessage(
			{ type: "toolCall", id, name: "apply_patch", arguments: { input: "" } },
			{ stopReason: "toolUse", timestamp: 0 },
		),
		{
			role: "toolResult",
			toolName: "apply_patch",
			toolCallId: id,
			timestamp: 0,
			isError: false,
			content: [{ type: "text", text: "patch result" }],
			details: {
				result,
				preview: { files: [preview], added: preview.added, removed: preview.removed },
			},
		},
	];
}

function click(
	surface: Awaited<ReturnType<typeof explorationSurface>>,
	target: { readonly row: number; readonly width: number; readonly x?: number },
) {
	const x = target.x ?? 6;
	return surface.chat.handleMouse({
		type: "click",
		button: "left",
		x,
		y: target.row,
		screenX: x,
		screenY: target.row,
		width: target.width,
		height: surface.chat.render(target.width).length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe.each(["compact", "grouped"] as const)("%s patch fold controls", (density) => {
	it("keeps repeated-path member folds when closing, reopening, and appending", async () => {
		const width = 64;
		const tool = createApplyPatchTool();
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(tool)]);
		const ui = new TUI(new VirtualTerminal(width, 40));
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			invoke(
				surface.mode,
				"renderSessionItems",
				[patch("patch-1", repeated), patch("patch-2", middle), patch("patch-3", repeated)].flat(),
			);
			surface.chat.setToolDisplayDensity(density);

			let output = surface.chat.render(width).map(stripTerminalSequences);
			const foldedTitle = output.findIndex((line) => line.includes("╶─ ✓ edited • repeated.txt"));
			expect(foldedTitle).toBeGreaterThanOrEqual(0);
			expect(click(surface, { row: foldedTitle, width })?.handled).toBe(true);

			output = surface.chat.render(width).map(stripTerminalSequences);
			const groupTitle = output.findIndex((line) => line.includes("╭─ ✓ edited •"));
			expect(groupTitle).toBeGreaterThanOrEqual(0);
			expect(click(surface, { row: groupTitle, width })?.handled).toBe(true);

			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╭─ ✓ edited • /p/repeated.txt:(+1 -1)"))).toBe(true);
			expect(output.some((line) => line.includes("╭─ ✓ edited • repeated.txt middle.txt repeated.txt"))).toBe(false);
			const foldedRepeatedHeadings = output.flatMap((line, index) =>
				line.includes("├─ edited • repeated.txt") ? [index] : [],
			);
			expect(foldedRepeatedHeadings).toHaveLength(1);
			expect(click(surface, { row: foldedRepeatedHeadings[0], width })?.handled).toBe(true);

			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╭─ ✓ edited •"))).toBe(true);
			expect(output.some((line) => line.includes("├─ edited • /p/repeated.txt"))).toBe(true);
			expect(output.filter((line) => line.includes(" │ -1 before"))).toHaveLength(2);
			expect(output.some((line) => line.includes("middle-before"))).toBe(false);
			expect(output.some((line) => line.includes("├─ edited • middle.txt"))).toBe(true);
			expect(output.some((line) => line.includes("├─ edited • /p/middle.txt"))).toBe(false);

			const openTitle = output.findIndex((line) => line.includes("╭─ ✓ edited •"));
			expect(click(surface, { row: openTitle, width, x: 1 })?.handled).toBe(true);
			output = surface.chat.render(width).map(stripTerminalSequences);
			const closedTitle = output.findIndex((line) => line.includes("╶─ ✓ edited •"));
			expect(closedTitle).toBeGreaterThanOrEqual(0);
			expect(click(surface, { row: closedTitle, width, x: 1 })?.handled).toBe(true);

			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.filter((line) => line.includes(" │ -1 before"))).toHaveLength(2);
			expect(output.some((line) => line.includes("middle-before"))).toBe(false);

			const appendedResult = patch("patch-4", appended)[1];
			const appendedCard = new ToolExecutionComponent(
				"apply_patch",
				"patch-4",
				{ input: "" },
				{},
				tool,
				ui,
				process.cwd(),
			);
			appendedCard.updateResult({
				content: appendedResult.content,
				details: appendedResult.details,
				isError: appendedResult.isError,
			});
			surface.chat.addChild(appendedCard);

			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╭─ ✓ edited •"))).toBe(true);
			expect(output.filter((line) => line.includes(" │ -1 before"))).toHaveLength(2);
			expect(output.some((line) => line.includes("middle-before"))).toBe(false);
			expect(output.some((line) => line.includes("appended-before"))).toBe(false);
		} finally {
			surface.cleanup();
			ui.stop();
		}
	});
});
