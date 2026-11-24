import path from "node:path";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type {
	ApplyPatchPreviewFile,
	ApplyPatchResult,
} from "../../src/core/extensions/builtin/gpt-apply-patch/types.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
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
const plainEdit: ApplyPatchPreviewFile = {
	...file,
	filePath: "/p/old.txt",
	movePath: undefined,
};
const third: ApplyPatchPreviewFile = {
	filePath: "/p/new.txt",
	operation: "add",
	diff: "+1 created",
	added: 1,
	removed: 0,
};
const fourth: ApplyPatchPreviewFile = {
	filePath: "/p/last.txt",
	operation: "update",
	diff: "-1 old\n+1 new",
	added: 1,
	removed: 1,
};

function replay(files: ApplyPatchPreviewFile[], failed = false, id = "patch", input = "", structured = true) {
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
		...(structured
			? {
					details: {
						result,
						preview: {
							files,
							added: files.reduce((n, f) => n + f.added, 0),
							removed: files.reduce((n, f) => n + f.removed, 0),
						},
					},
				}
			: {}),
	};
	return [
		fauxAssistantMessage(
			{ type: "toolCall", id, name: "apply_patch", arguments: { input } },
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
	input = "",
	structured = true,
) {
	const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
	try {
		if (!(surface.chat instanceof ExplorationTranscriptContainer))
			throw new TypeError("Expected exploration transcript");
		invoke(surface.mode, "renderSessionItems", replay(files, failed, "patch", input, structured));
		surface.chat.setToolDisplayDensity(density);
		invoke(surface.mode, "setToolsExpanded", expanded);
		return surface.chat.render(width).map(stripTerminalSequences);
	} finally {
		surface.cleanup();
	}
}

async function rowsForCalls(
	density: "compact" | "grouped",
	expanded: boolean,
	calls: { files: ApplyPatchPreviewFile[]; failed?: boolean; id?: string }[],
	width = 48,
) {
	const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
	try {
		if (!(surface.chat instanceof ExplorationTranscriptContainer))
			throw new TypeError("Expected exploration transcript");
		invoke(
			surface.mode,
			"renderSessionItems",
			calls.flatMap(({ files, failed, id }, index) => replay(files, failed, id ?? `patch-${index + 1}`)),
		);
		surface.chat.setToolDisplayDensity(density);
		invoke(surface.mode, "setToolsExpanded", expanded);
		return surface.chat.render(width).map(stripTerminalSequences);
	} finally {
		surface.cleanup();
	}
}

function click(surface: Awaited<ReturnType<typeof explorationSurface>>, y: number, width: number) {
	return surface.chat.handleMouse({
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: y,
		width,
		height: surface.chat.render(width).length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

function card(width: number, ...body: string[]) {
	return ["", ...["", ...body, ""].map((row) => row.padEnd(width))];
}

describe.each(["compact", "grouped"] as const)("%s apply patch density", (density) => {
	it("shows the applied move with both paths and exact diff rows", async () => {
		expect(await rows(density, false, [file])).toEqual(card(48, " ╶─ ✓ edited • old.txt → new.txt · (+1 -1)"));
		expect(await rows(density, true, [file])).toEqual(
			card(48, " ╭─ ✓ edited • /p/old.txt → /p/new.txt:(+1 -1)", " │ -1 before", " │ +1 after", " ╰─"),
		);
	});

	it("keeps two mixed-operation files as separate cards", async () => {
		const folded = await rows(density, false, [file, second]);
		expect(folded.filter((line) => line.includes("edited • old.txt → new.txt · (+1 -1)"))).toHaveLength(1);
		expect(folded.filter((line) => line.includes("deleted • gone.txt · (+0 -1)"))).toHaveLength(1);
		const expanded = await rows(density, true, [file, second]);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(2);
		expect(expanded).toContain(" ╭─ ✓ edited • /p/old.txt → /p/new.txt:(+1 -1)".padEnd(48));
		expect(expanded).toContain(" ╭─ ✓ deleted • /p/gone.txt:(+0 -1)".padEnd(48));
		expect(expanded).toContain(" │ -1 before".padEnd(48));
		expect(expanded).toContain(" │ -1 removed".padEnd(48));
	});

	it("groups three mixed-operation files under patched", async () => {
		const folded = await rows(density, false, [plainEdit, second, third]);
		expect(folded.filter((line) => line.includes("patched • old.txt gone.txt new.txt"))).toHaveLength(1);
		const expanded = await rows(density, true, [plainEdit, second, third]);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(1);
		expect(expanded).toContain(" ╭─ ✓ patched • old.txt gone.txt new.txt".padEnd(48));
		expect(expanded).toContain(" ├─ edited • /p/old.txt:(+1 -1)".padEnd(48));
		expect(expanded).toContain(" ├─ deleted • /p/gone.txt:(+0 -1)".padEnd(48));
		expect(expanded).toContain(" ├─ added • /p/new.txt:(+1 -0)".padEnd(48));
		expect(expanded).toContain(" │ -1 removed".padEnd(48));
		expect(expanded).toContain(" │ +1 created".padEnd(48));
	});

	it.each([
		{
			operation: "edited",
			files: [plainEdit, fourth, { ...plainEdit, filePath: "/p/third.txt" }],
			folded: "edited • old.txt last.txt third.txt",
			subtitles: ["edited • /p/old.txt:(+1 -1)", "edited • /p/last.txt:(+1 -1)", "edited • /p/third.txt:(+1 -1)"],
		},
		{
			operation: "added",
			files: [
				{ ...third, filePath: "/p/add-a.txt" },
				{ ...third, filePath: "/p/add-b.txt" },
				{ ...third, filePath: "/p/add-c.txt" },
			],
			folded: "added • add-a.txt add-b.txt add-c.txt",
			subtitles: ["added • /p/add-a.txt:(+1 -0)", "added • /p/add-b.txt:(+1 -0)", "added • /p/add-c.txt:(+1 -0)"],
		},
		{
			operation: "deleted",
			files: [
				{ ...second, filePath: "/p/delete-a.txt" },
				{ ...second, filePath: "/p/delete-b.txt" },
				{ ...second, filePath: "/p/delete-c.txt" },
			],
			folded: "deleted • delete-a.txt delete-b.txt delete-c.txt",
			subtitles: [
				"deleted • /p/delete-a.txt:(+0 -1)",
				"deleted • /p/delete-b.txt:(+0 -1)",
				"deleted • /p/delete-c.txt:(+0 -1)",
			],
		},
	])("separates pairs and groups three homogeneous $operation files", async ({ files, folded, subtitles }) => {
		const width = 80;
		const pair = await rows(density, false, files.slice(0, 2), false, width);
		expect(pair.filter((line) => line.includes(`${folded.split(" • ")[0]} •`))).toHaveLength(2);

		const grouped = await rows(density, false, files, false, width);
		expect(grouped.filter((line) => line.includes(folded))).toHaveLength(1);
		const expanded = await rows(density, true, files, false, width);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(1);
		expect(expanded).toContain(` ╭─ ✓ ${folded}`.padEnd(width));
		for (const subtitle of subtitles) {
			expect(expanded).toContain(` ├─ ${subtitle}`.padEnd(width));
		}
	});

	it("distinguishes a partial failure from complete success", async () => {
		const input = "*** Begin Patch\n*** Update File: /p/old.txt\n@@\n-before\n+after\n*** End Patch";
		const expanded = await rows(density, true, [file], true, 48, input);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(2);
		expect(expanded.some((line) => line.includes("✗ edited •") && line.includes("/p/old.txt"))).toBe(true);
		expect(expanded).toContain(" │ missing: not found".padEnd(48));
		expect(expanded).toContain(" ╭─ ✓ edited • /p/old.txt → /p/new.txt:(+1 -1)".padEnd(48));
		expect(expanded).toContain(" │ -1 before".padEnd(48));

		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			invoke(surface.mode, "renderSessionItems", replay([file], true, "patch", input));
			surface.chat.setToolDisplayDensity(density);
			invoke(surface.mode, "setToolsExpanded", true);
			let output = surface.chat.render(48).map(stripTerminalSequences);
			const failureTitle = output.findIndex((line) => line.includes("✗ edited • /p/old.txt"));
			expect(click(surface, failureTitle, 48)?.handled).toBe(true);
			invoke(surface.mode, "setToolsExpanded", false);
			invoke(surface.mode, "setToolsExpanded", true);
			output = surface.chat.render(48).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╭─ ✗ edited • /p/old.txt"))).toBe(true);
		} finally {
			surface.cleanup();
		}
	});

	it("does not claim an operation when all files fail", async () => {
		expect(await rows(density, true, [], true)).toEqual(
			card(48, " ╭─ ✗ patched • apply_patch · failed", " │ missing: not found", " ╰─"),
		);
	});

	it.each([
		{
			operation: "edited",
			path: "/p/changed.txt",
			input: "*** Begin Patch\n*** Update File: /p/changed.txt\n@@\n-old\n+new\n*** End Patch",
		},
		{
			operation: "added",
			path: "/p/created.txt",
			input: "*** Begin Patch\n*** Add File: /p/created.txt\n+created\n*** End Patch",
		},
		{
			operation: "deleted",
			path: "/p/removed.txt",
			input: "*** Begin Patch\n*** Delete File: /p/removed.txt\n*** End Patch",
		},
	])("classifies a legacy failure from its valid homogeneous $operation call", async ({ operation, path, input }) => {
		const expanded = await rows(density, true, [], true, 48, input, false);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(1);
		expect(expanded.some((line) => line.includes(`✗ ${operation} • `) && line.includes(path))).toBe(true);
		expect(expanded).toContain(" │ missing: not found".padEnd(48));
	});

	it("uses patched for mixed or invalid intended operations", async () => {
		const mixed = "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Delete File: removed.txt\n*** End Patch";
		const expanded = await rows(density, true, [], true, 48, mixed, false);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(1);
		expect(expanded.some((line) => line.includes("✗ patched • apply_patch"))).toBe(true);
		expect(expanded).toContain(" │ missing: not found".padEnd(48));

		const invalid = await rows(density, true, [], true, 48, "not a patch", false);
		expect(invalid.some((line) => line.includes("✗ patched • apply_patch"))).toBe(true);
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
		expect(await rows(density, false, [file], false, 24)).toEqual(card(24, " ╶─ ✓ edited • old.tx…"));
	});

	it("retains a diff truncation marker", async () => {
		expect(await rows(density, true, [{ ...second, diff: "-1 removed\n…" }])).toEqual(
			card(48, " ╭─ ✓ deleted • /p/gone.txt:(+0 -1)", " │ -1 removed", " │ …", " ╰─"),
		);
	});

	it("resolves relative paths against the session directory", async () => {
		const relative = { ...file, filePath: "src/old.txt", movePath: "src/new.txt" };
		const title = ` ╭─ ✓ edited • ${path.resolve(process.cwd(), "src/old.txt")} → ${path.resolve(process.cwd(), "src/new.txt")}:(+1 -1)`;
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
			const first = " ╶─ ✓ edited • old.txt → new.txt · (+1 -1)";
			const next = " ╶─ ✓ deleted • gone.txt · (+0 -1)";
			expect(surface.chat.render(48).map(stripTerminalSequences)).toEqual(
				density === "compact" ? [...card(48, first), ...card(48, next)] : card(48, first, next),
			);
		} finally {
			surface.cleanup();
		}
	});

	it("groups three consecutive successful singleton calls", async () => {
		const folded = await rowsForCalls(density, false, [
			{ files: [plainEdit] },
			{ files: [second] },
			{ files: [third] },
		]);
		expect(folded.filter((line) => line.includes("patched • old.txt gone.txt new.txt"))).toHaveLength(1);
		const expanded = await rowsForCalls(density, true, [
			{ files: [plainEdit] },
			{ files: [second] },
			{ files: [third] },
		]);
		expect(expanded.filter((line) => line.includes("╭─"))).toHaveLength(1);
		expect(expanded).toContain(" ├─ edited • /p/old.txt:(+1 -1)".padEnd(48));
		expect(expanded).toContain(" ├─ deleted • /p/gone.txt:(+0 -1)".padEnd(48));
		expect(expanded).toContain(" ├─ added • /p/new.txt:(+1 -0)".padEnd(48));
	});

	it("ends consecutive successful runs at failed and non-patch results", async () => {
		const failed = await rowsForCalls(density, false, [
			{ files: [file] },
			{ files: [], failed: true },
			{ files: [second] },
		]);
		expect(failed.some((line) => line.includes("patched • old.txt gone.txt"))).toBe(false);
		expect(failed.some((line) => line.includes("edited • old.txt"))).toBe(true);
		expect(failed.some((line) => line.includes("patched • apply_patch"))).toBe(true);
		expect(failed.some((line) => line.includes("deleted • gone.txt"))).toBe(true);

		const surface = await explorationSurface(true, [(pi) => pi.registerTool(createApplyPatchTool())]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			invoke(surface.mode, "renderSessionItems", [
				...replay([plainEdit], false, "before"),
				fauxAssistantMessage("Between patches."),
				...replay([second], false, "after"),
				...replay([third], false, "last"),
			]);
			surface.chat.setToolDisplayDensity(density);
			invoke(surface.mode, "setToolsExpanded", false);
			const output = surface.chat.render(48).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("patched •"))).toBe(false);
			expect(output.some((line) => line.includes("Between patches."))).toBe(true);
		} finally {
			surface.cleanup();
		}
	});

	it("clicks file cards independently and keeps global expansion", async () => {
		const width = 48;
		const tool = createApplyPatchTool();
		const renderResult = vi.spyOn(tool, "renderResult");
		const surface = await explorationSurface(true, [(pi) => pi.registerTool(tool)]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer))
				throw new TypeError("Expected exploration transcript");
			invoke(surface.mode, "renderSessionItems", replay([plainEdit, second]));
			surface.chat.render(width);
			const original = surface.chat.children.find(
				(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
			);
			if (!original) throw new TypeError("Expected the original apply_patch card");
			const renderResultCalls = renderResult.mock.calls.length;
			original.invalidate();
			surface.chat.setToolDisplayDensity(density);
			invoke(surface.mode, "setToolsExpanded", false);

			let output = surface.chat.render(width).map(stripTerminalSequences);
			expect(renderResult).toHaveBeenCalledTimes(renderResultCalls);
			expect(output.some((line) => line.includes("edited • old.txt"))).toBe(true);
			expect(output.some((line) => line.includes("deleted • gone.txt"))).toBe(true);
			const firstTitle = output.findIndex((line) => line.includes("edited • old.txt"));
			expect(click(surface, firstTitle, width)?.handled).toBe(true);
			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╭─ ✓ edited • /p/old.txt"))).toBe(true);
			expect(output.some((line) => line.includes("╶─ ✓ deleted • gone.txt"))).toBe(true);

			const secondTitle = output.findIndex((line) => line.includes("deleted • gone.txt"));
			expect(click(surface, secondTitle, width)?.handled).toBe(true);
			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.filter((line) => line.includes("╭─"))).toHaveLength(2);

			const expandedFirstTitle = output.findIndex((line) => line.includes("edited • /p/old.txt"));
			expect(click(surface, expandedFirstTitle, width)?.handled).toBe(true);
			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╶─ ✓ edited • old.txt"))).toBe(true);
			expect(output.some((line) => line.includes("╭─ ✓ deleted • /p/gone.txt"))).toBe(true);

			invoke(surface.mode, "setToolsExpanded", true);
			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.filter((line) => line.includes("╭─"))).toHaveLength(2);
			invoke(surface.mode, "setToolsExpanded", false);
			output = surface.chat.render(width).map(stripTerminalSequences);
			expect(output.some((line) => line.includes("╶─ ✓ edited • old.txt"))).toBe(true);
			expect(output.some((line) => line.includes("╶─ ✓ deleted • gone.txt"))).toBe(true);
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
