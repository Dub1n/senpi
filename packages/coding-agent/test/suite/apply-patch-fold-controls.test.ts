import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchResult,
} from "../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import { toolCardNestingDefaults } from "../../src/core/settings-manager.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const repeated = file("/p/repeated.txt", "-1 before\n+1 after");
const middle = file("/p/middle.txt", "-1 middle-before\n+1 middle-after");
const appended = file("/p/appended.txt", "-1 appended-before\n+1 appended-after");

function file(filePath: string, diff: string): ApplyPatchPreviewFile {
	return { filePath, operation: "update", diff, added: 1, removed: 1 };
}

function patch(
	id: string,
	...previews: ApplyPatchPreviewFile[]
): [ReturnType<typeof fauxAssistantMessage>, ToolResultMessage] {
	const result: ApplyPatchResult = {
		summaries: [],
		appliedFiles: previews.map((preview) => preview.filePath),
		failures: [],
		hasPartialSuccess: false,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: [] },
		details: { fuzz: 0, appliedOperations: previews.map((preview, operationIndex) => ({ operationIndex, preview })) },
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
				preview: {
					files: previews,
					added: previews.reduce((total, preview) => total + preview.added, 0),
					removed: previews.reduce((total, preview) => total + preview.removed, 0),
				},
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
	it("uses the renamed parent default after a close, but keeps an explicit open and independent member defaults", async () => {
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		const width = 100;
		try {
			const chat = surface.chat;
			if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			chat.setToolDisplayDensity(density);
			chat.setDenseCardPreferences(
				{ edited: "folded", added: "unfolded", patched: "unfolded" },
				toolCardNestingDefaults,
			);
			const add = (filePath: string, diff: string): ApplyPatchPreviewFile => ({
				...file(filePath, diff),
				operation: "add",
				removed: 0,
			});
			const earlier = [patch("one", repeated), patch("two", middle), patch("three", repeated)];
			invoke(surface.mode, "renderSessionItems", earlier.flat());
			const clickHeading = (pattern: RegExp) => {
				const output = chat.render(width).map(stripTerminalSequences);
				const row = output.findIndex((line) => pattern.test(line));
				expect(output[row]).toMatch(pattern);
				expect(click(surface, { row, width, x: 1 })?.handled).toBe(true);
			};
			clickHeading(/╶─.*edited/u);
			clickHeading(/╭─.*edited/u);
			const added = patch("new", add("/p/new.txt", "+1 show-new-file"));
			invoke(surface.mode, "renderSessionItems", added);
			const renamed = surface.text(width);
			expect(renamed).toMatch(/╭─.*edited/u);
			expect(renamed).toContain("show-new-file");
			expect(renamed).not.toContain("middle-before");

			// Splitting and recombining the run must not recreate its member choices.
			clickHeading(/╭─.*edited/u);
			clickHeading(/╶─.*patched/u);
			chat.setDenseCardPreferences(
				{ edited: "folded", added: "unfolded", patched: "folded" },
				{
					...toolCardNestingDefaults,
					patches: false,
				},
			);
			expect(surface.text(width).match(/╶─.*edited/gu)).toHaveLength(3);
			chat.setDenseCardPreferences(
				{ edited: "folded", added: "unfolded", patched: "folded" },
				toolCardNestingDefaults,
			);
			expect(surface.text(width)).toContain("show-new-file");
			expect(surface.text(width)).not.toContain("middle-before");
		} finally {
			surface.cleanup();
		}
	});

	it("moves the final folded patch file title to the nest ending and keeps it clickable", async () => {
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		const width = 100;
		try {
			const chat = surface.chat;
			if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			chat.setToolDisplayDensity(density);
			chat.setDenseCardPreferences({ edited: "unfolded", patched: "unfolded" }, toolCardNestingDefaults);
			invoke(surface.mode, "renderSessionItems", [
				...patch("one", repeated),
				...patch("two", middle),
				...patch("three", appended),
			]);

			const clickTitle = (pattern: RegExp) => {
				const output = chat.render(width).map(stripTerminalSequences);
				const row = output.findIndex((line) => pattern.test(line));
				expect(output[row]).toMatch(pattern);
				expect(click(surface, { row, width })?.handled).toBe(true);
			};
			clickTitle(/├─.*appended\.txt/u);
			expect(surface.text(width)).toContain("╰─ edited • appended.txt");
			expect(surface.text(width)).not.toMatch(/^ ╰─\s*$/mu);

			clickTitle(/╰─.*appended\.txt/u);
			expect(surface.text(width)).toContain("│ -1 appended-before");
			expect(surface.text(width)).toMatch(/^ ╰─\s*$/mu);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps one invocation's file sections when cross-call patch nesting is disabled", async () => {
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			const chat = surface.chat;
			if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			chat.setToolDisplayDensity(density);
			chat.setDenseCardPreferences({ edited: "unfolded" }, { ...toolCardNestingDefaults, patches: false });
			invoke(surface.mode, "renderSessionItems", [patch("many", repeated, middle), patch("other", appended)].flat());
			const text = surface.text(100);
			expect(text.match(/╭─.*edited/gu)).toHaveLength(2);
			expect(text).toMatch(
				/╭─.*repeated\.txt[^\n]*\n[\s\S]*├─.*middle\.txt[\s\S]*╰─[^\n]*\n[\s\S]*╭─.*appended\.txt/u,
			);
			expect(text).toContain("middle-before");
			expect(text).toContain("appended-before");
		} finally {
			surface.cleanup();
		}
	});

	it("reveals a renamed nest for one joining invocation and does not replay that reveal", async () => {
		const width = 80;
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			const chat = surface.chat;
			chat.setToolDisplayDensity(density);
			const earlier = [patch("earlier-1", repeated), patch("earlier-2", middle), patch("earlier-3", repeated)];
			invoke(surface.mode, "renderSessionItems", earlier.flat());
			const toolName = "apply_patch";
			const toolCallId = "joining";
			await surface.event({ type: "tool_execution_start", toolCallId, toolName, args: { input: "" } });
			const clickLabel = (pattern: RegExp, x = 6) => {
				const output = chat.render(width).map(stripTerminalSequences);
				const row = output.findIndex((line) => pattern.test(line));
				expect(output[row]).toMatch(pattern);
				expect(click(surface, { row, width, x })?.handled).toBe(true);
			};
			// The new invocation starts after the three files already in a nest.
			clickLabel(/╶─.*edited/u, 1);
			clickLabel(/├─.*middle\.txt/u);
			clickLabel(/╭─.*edited/u, 1);
			clickLabel(/╶─.*apply_patch/u);
			const joined = patch(toolCallId, file("/p/repeated.txt", "-1 joining-before\n+1 joining-after"), {
				...file("/p/new.txt", "+1 joining-added"),
				operation: "add",
				removed: 0,
			});
			await surface.event({ type: "tool_execution_end", toolCallId, toolName, result: joined[1], isError: false });

			const opened = surface.text(width);
			expect(opened).toMatch(/^ ╭─.*edited/mu);
			expect(opened.match(/joining-(before|after|added)/gu)).toHaveLength(3);
			expect(opened).toContain("middle-before");
			expect(opened).not.toMatch(/│ -1 before/u);
			clickLabel(/╭─.*edited/u, 1);
			expect(surface.text(width)).toMatch(/^\s*╶─.*patched/mu);

			const untouched = patch("untouched", appended);
			chat.clear();
			invoke(surface.mode, "renderSessionItems", [...earlier, joined, untouched].flat());
			chat.invalidate();
			expect(surface.text(width)).toMatch(/^\s*╶─.*patched/mu);
			clickLabel(/╶─.*patched/u, 1);
			const reopened = surface.text(width);
			expect(reopened.match(/joining-(before|after|added)/gu)).toHaveLength(3);
			expect(reopened).toContain("middle-before");
			expect(reopened).not.toMatch(/appended-before|│ -1 before/u);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["default-open", "initial-open-then-folded", "initial-folded-then-refolded"] as const)(
		"does not reveal a closed parent for a %s live member",
		async (scenario) => {
			const width = 100;
			const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
			try {
				if (!(surface.chat instanceof ExplorationTranscriptContainer))
					throw new TypeError("Expected exploration transcript");
				const chat = surface.chat;
				chat.setToolDisplayDensity(density);
				invoke(surface.mode, "renderSessionItems", [patch("earlier", repeated), patch("other", middle)].flat());
				const toolCallId = "incoming";
				const toolName = "apply_patch";
				await surface.event({ type: "tool_execution_start", toolCallId, toolName, args: { input: "" } });
				const card = chat.children.at(-1);
				if (!(card instanceof ToolExecutionComponent)) throw new TypeError("Expected the pending patch owner");
				const clickLabel = (pattern: RegExp, x = 6) => {
					const output = chat.render(width).map(stripTerminalSequences);
					const row = output.findIndex((line) => pattern.test(line));
					expect(output[row]).toMatch(pattern);
					expect(click(surface, { row, width, x })?.handled).toBe(true);
				};
				if (scenario === "initial-folded-then-refolded") {
					clickLabel(/╶─.*apply_patch/u);
					clickLabel(/╭─.*apply_patch/u);
				}
				// The invocation's renderer is now default-open. This distinguishes
				// the captured initial-open manual fold from an abandoned refold.
				card.setExpanded(true);
				if (scenario === "initial-open-then-folded") clickLabel(/╭─.*apply_patch/u);
				await surface.event({
					type: "tool_execution_end",
					toolCallId,
					toolName,
					result: patch(toolCallId, appended)[1],
					isError: false,
				});
				expect(surface.text(width)).toMatch(/╶─.*edited.*repeated\.txt.*middle\.txt.*appended\.txt/u);
				clickLabel(/╶─.*edited.*appended\.txt/u, 1);
				expect(surface.text(width).includes("appended-before")).toBe(scenario !== "initial-open-then-folded");
			} finally {
				surface.cleanup();
			}
		},
	);

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
				line.includes("╰─ edited • repeated.txt") ? [index] : [],
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
