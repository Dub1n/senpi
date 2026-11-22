import path from "node:path";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchResult,
} from "../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const file: ApplyPatchPreviewFile = {
	filePath: "/p/old.txt",
	movePath: "/p/new.txt",
	operation: "update",
	diff: "-1 before\n+1 after",
	added: 1,
	removed: 1,
};
const second: ApplyPatchPreviewFile = {
	filePath: "/p/gone.txt",
	operation: "delete",
	diff: "-1 removed",
	added: 0,
	removed: 1,
};

function replay(files: ApplyPatchPreviewFile[], failed = false, id = "patch") {
	const result: ApplyPatchResult = {
		summaries: [],
		appliedFiles: files.map((item) => item.filePath),
		failures: failed
			? [{ operationIndex: files.length, filePath: "missing", operation: "delete", message: "not found" }]
			: [],
		hasPartialSuccess: failed && files.length > 0,
		recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: failed ? ["missing"] : [] },
		details: { fuzz: 0, appliedOperations: files.map((preview, operationIndex) => ({ operationIndex, preview })) },
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolName: "apply_patch",
		toolCallId: id,
		timestamp: 0,
		isError: failed,
		content: [{ type: "text", text: failed ? "missing: not found" : "patch result" }],
		details: {
			result,
			preview: {
				files,
				added: files.reduce((n, f) => n + f.added, 0),
				removed: files.reduce((n, f) => n + f.removed, 0),
			},
		},
	};
	return [
		fauxAssistantMessage(
			{ type: "toolCall", id, name: "apply_patch", arguments: { input: "" } },
			{ stopReason: "toolUse", timestamp: 0 },
		),
		toolResult,
	];
}

async function rows(
	density: "compact" | "grouped" | "default",
	expanded: boolean,
	files: ApplyPatchPreviewFile[],
	failed = false,
	width = 48,
) {
	const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
	try {
		if (!(surface.chat instanceof ExplorationTranscriptContainer))
			throw new TypeError("Expected exploration transcript");
		invoke(surface.mode, "renderSessionItems", replay(files, failed));
		surface.chat.setToolDisplayDensity(density);
		invoke(surface.mode, "setToolsExpanded", expanded);
		return surface.chat.render(width).map(stripTerminalSequences);
	} finally {
		surface.cleanup();
	}
}

function card(width: number, ...body: string[]) {
	return ["", ...["", ...body, ""].map((row) => row.padEnd(width))];
}

describe.each(["compact", "grouped"] as const)("%s apply patch density", (density) => {
	it("shows the applied move with both paths and exact diff rows", async () => {
		expect(await rows(density, false, [file])).toEqual(card(48, " ╶─ ✓ edited old.txt → new.txt • (+1 -1)"));
		expect(await rows(density, true, [file])).toEqual(
			card(48, " ╭─ ✓ edited /p/old.txt → /p/new.txt • (+1 -1)", " │ -1 before", " │ +1 after", " ╰─"),
		);
	});

	it("keeps multiple files within one expanded card", async () => {
		expect(await rows(density, true, [file, second])).toEqual(
			card(
				48,
				" ╭─ ✓ tool apply_patch • 2 files",
				" ├─ edited /p/old.txt → /p/new.txt • (+1 -1)",
				" │ -1 before",
				" │ +1 after",
				" ├─ deleted /p/gone.txt • (+0 -1)",
				" │ -1 removed",
				" ╰─",
			),
		);
	});

	it("distinguishes a partial failure from complete success", async () => {
		expect(await rows(density, true, [file], true)).toEqual(
			card(
				48,
				" ╭─ ✗ tool apply_patch • failed",
				" │ missing: not found",
				" ├─ edited /p/old.txt → /p/new.txt • (+1 -1)",
				" │ -1 before",
				" │ +1 after",
				" ╰─",
			),
		);
	});

	it("does not claim an operation when all files fail", async () => {
		expect(await rows(density, true, [], true)).toEqual(
			card(48, " ╭─ ✗ tool apply_patch • failed", " │ missing: not found", " ╰─"),
		);
	});

	it("does not claim an operation for an incomplete result", async () => {
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			const [call, result] = replay([file]);
			invoke(surface.mode, "renderSessionItems", [
				call,
				{
					...result,
					content: [{ type: "text", text: "waiting for patch" }],
					details: { progress: { applied: 1, failed: 0, total: 2 } },
				},
			]);
			surface.chat.setToolDisplayDensity(density);
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.chat.render(48).map(stripTerminalSequences)).toEqual(
				card(48, " ╭─ ○ tool apply_patch • pending", " │ progress: 1/2", " │ waiting for patch", " ╰─"),
			);
		} finally {
			surface.cleanup();
		}
	});

	it("truncates a narrow folded title", async () => {
		expect(await rows(density, false, [file], false, 24)).toEqual(card(24, " ╶─ ✓ edited old.txt …"));
	});

	it("retains a diff truncation marker", async () => {
		expect(await rows(density, true, [{ ...second, diff: "-1 removed\n…" }])).toEqual(
			card(48, " ╭─ ✓ deleted /p/gone.txt • (+0 -1)", " │ -1 removed", " │ …", " ╰─"),
		);
	});

	it("resolves relative paths against the session directory", async () => {
		const relative = { ...file, filePath: "src/old.txt", movePath: "src/new.txt" };
		const title = ` ╭─ ✓ edited ${path.resolve(process.cwd(), "src/old.txt")} → ${path.resolve(process.cwd(), "src/new.txt")} • (+1 -1)`;
		expect(visibleWidth(title)).toBeLessThanOrEqual(238);
		expect(await rows(density, true, [relative], false, 240)).toEqual(
			card(240, title, " │ -1 before", " │ +1 after", " ╰─"),
		);
	});

	it("keeps consecutive patch calls in separate cards", async () => {
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			invoke(surface.mode, "renderSessionItems", [...replay([file]), ...replay([second], false, "patch-2")]);
			surface.chat.setToolDisplayDensity(density);
			invoke(surface.mode, "setToolsExpanded", false);
			const first = " ╶─ ✓ edited old.txt → new.txt • (+1 -1)";
			const next = " ╶─ ✓ deleted gone.txt • (+0 -1)";
			expect(surface.chat.render(48).map(stripTerminalSequences)).toEqual(
				density === "compact" ? [...card(48, first), ...card(48, next)] : card(48, first, next),
			);
		} finally {
			surface.cleanup();
		}
	});
});

it("retains the representative default move rendering", async () => {
	expect(await rows("default", true, [file])).toEqual([
		"",
		...[
			"",
			" apply_patch: Patching",
			"",
			"  Applied patch",
			"",
			"  • Edited /p/old.txt → /p/new.txt (+1 -1)",
			"  -1 before",
			"  +1 after",
			"",
			"",
		].map((row) => row.padEnd(48)),
	]);
});
