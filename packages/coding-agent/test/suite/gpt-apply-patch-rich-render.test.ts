import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createApplyPatchTool,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
	renderPatchPreview,
	truncatePreview,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import { renderToolDiff } from "../../src/core/tools/diff-render.ts";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

type ApplyPatchTool = ReturnType<typeof createApplyPatchTool>;
type ApplyPatchArgs = { input: string };
type ApplyPatchState = Record<string, unknown>;

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

const successBg = "\x1b[48;2;40;50;40m";
const bgReset = "\x1b[49m";
const ansiTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function createRenderContext(cwd: string, args: ApplyPatchArgs, overrides: Partial<ToolRenderContext> = {}) {
	return {
		args,
		toolCallId: "call-streaming-preview",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: false,
		argsComplete: false,
		isPartial: true,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	} satisfies ToolRenderContext<ApplyPatchState, ApplyPatchArgs>;
}

describe("gpt apply_patch rich TUI rendering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("renders streamed arguments as a rich patch preview before execution starts", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const args = {
			input: `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** Add File: created.txt
+created
`,
		};
		const tool = createApplyPatchTool();

		const component = tool.renderCall?.(args, theme, createRenderContext(harness.tempDir, args));
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(rendered).toContain("Applying patch");
		expect(rendered).toContain("sample.txt");
		expect(rendered).toContain("- before");
		expect(rendered).toContain("+ after");
		expect(rendered).toContain("created.txt");
	});

	it("keeps the real diff visible after apply_patch finishes", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "sample.txt"), "before\n", "utf-8");
		const args = {
			input: `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`,
		};
		const tool = createApplyPatchTool();

		const result = await tool.execute("call-rich-result", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(await readFile(path.join(harness.tempDir, "sample.txt"), "utf-8")).toBe("after\n");
		expect(result.details?.preview).toBeDefined();
		expect(rendered).toContain("Applied patch");
		expect(rendered).toContain("sample.txt (+1 -1)");
		expect(rendered).toContain("-1 before");
		expect(rendered).toContain("+1 after");
	});

	it("renders binary deletions without raw byte previews", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const targetPath = path.join(harness.tempDir, "--full-page");
		await writeFile(
			targetPath,
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x41]),
		);
		const args = {
			input: `*** Begin Patch
*** Delete File: --full-page
*** End Patch`,
		};
		const tool = createApplyPatchTool();
		let pendingRendered = "";

		const result = await tool.execute(
			"call-binary-delete",
			args,
			undefined,
			(update) => {
				const component = tool.renderResult?.(
					update,
					{ expanded: true, isPartial: true },
					theme,
					createRenderContext(harness.tempDir, args, {
						executionStarted: true,
						argsComplete: true,
						isPartial: true,
					}),
				);
				pendingRendered = stripAnsi(component?.render(120).join("\n") ?? "");
			},
			{ cwd: harness.tempDir } as Parameters<ApplyPatchTool["execute"]>[4],
		);
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const completedRendered = stripAnsi(component?.render(120).join("\n") ?? "");

		await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.details?.preview?.files[0]).toMatchObject({
			filePath: "--full-page",
			operation: "delete",
			binary: true,
			diff: "",
			added: 0,
			removed: 0,
		});
		for (const rendered of [pendingRendered, completedRendered]) {
			expect(rendered).toContain("--full-page (binary)");
			expect(rendered).not.toContain("PNG");
			expect(rendered).not.toContain("\uFFFD");
			expect(rendered).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
		}
	});

	it("moves binary files without decoding bytes into previews", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const sourcePath = path.join(harness.tempDir, "source.png");
		const destinationPath = path.join(harness.tempDir, "moved.png");
		const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x41]);
		await writeFile(sourcePath, binary);
		const args = {
			input: `*** Begin Patch
*** Update File: source.png
*** Move to: moved.png
*** End Patch`,
		};
		const tool = createApplyPatchTool();
		let pendingPreview: unknown;
		let pendingRendered = "";

		const result = await tool.execute(
			"call-binary-move",
			args,
			undefined,
			(update) => {
				pendingPreview = update.details?.preview?.files[0];
				const component = tool.renderResult?.(
					update,
					{ expanded: true, isPartial: true },
					theme,
					createRenderContext(harness.tempDir, args, {
						executionStarted: true,
						argsComplete: true,
						isPartial: true,
					}),
				);
				pendingRendered = stripAnsi(component?.render(120).join("\n") ?? "");
			},
			{ cwd: harness.tempDir } as Parameters<ApplyPatchTool["execute"]>[4],
		);
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const completedRendered = stripAnsi(component?.render(120).join("\n") ?? "");

		await expect(readFile(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(destinationPath)).toEqual(binary);
		expect(pendingPreview).toMatchObject({
			filePath: "source.png",
			movePath: "moved.png",
			operation: "update",
			binary: true,
			diff: "",
			added: 0,
			removed: 0,
		});
		expect(pendingPreview).not.toHaveProperty("patch");
		expect(result.details?.preview?.files[0]).toMatchObject({
			filePath: "source.png",
			movePath: "moved.png",
			operation: "update",
			binary: true,
			diff: "",
			added: 0,
			removed: 0,
		});
		expect(result.details?.preview?.files[0]).not.toHaveProperty("patch");
		for (const rendered of [pendingRendered, completedRendered]) {
			expect(rendered).toContain("source.png");
			expect(rendered).toContain("moved.png");
			expect(rendered).toContain("(binary)");
			expect(rendered).not.toContain("PNG");
			expect(rendered).not.toContain("\uFFFD");
		}
	});

	it("rejects text hunks against binary files without mutating bytes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sourcePath = path.join(harness.tempDir, "source.png");
		const destinationPath = path.join(harness.tempDir, "moved.png");
		const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x41]);
		await writeFile(sourcePath, binary);
		const tool = createApplyPatchTool();

		const result = await tool.execute(
			"call-binary-text-hunk",
			{
				input: `*** Begin Patch
*** Update File: source.png
*** Move to: moved.png
@@
-old
+new
*** End Patch`,
			},
			undefined,
			undefined,
			{ cwd: harness.tempDir } as Parameters<ApplyPatchTool["execute"]>[4],
		);

		expect(await readFile(sourcePath)).toEqual(binary);
		await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.details?.result?.failures).toHaveLength(1);
		expect(result.details?.result?.failures[0]?.message).toContain(
			"apply_patch cannot apply text hunks to binary file: source.png",
		);
		expect(result.details?.result?.appliedFiles).toEqual([]);
	});

	it("keeps the changed hunk visible when the applied diff is large", async () => {
		initTheme("dark");
		const harness = await createHarness();
		harnesses.push(harness);
		const original = `${Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
		await writeFile(path.join(harness.tempDir, "large.txt"), original, "utf-8");
		const args = {
			input: `*** Begin Patch
*** Update File: large.txt
@@
-line-30
+line-30 updated
*** End Patch`,
		};
		const tool = createApplyPatchTool();

		const result = await tool.execute("call-large-rich-result", args, undefined, undefined, {
			cwd: harness.tempDir,
		} as Parameters<ApplyPatchTool["execute"]>[4]);
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext(harness.tempDir, args, { executionStarted: true, argsComplete: true, isPartial: false }),
		);
		const rendered = stripAnsi(component?.render(120).join("\n") ?? "");

		expect(await readFile(path.join(harness.tempDir, "large.txt"), "utf-8")).toContain("line-30 updated");
		expect(rendered).toContain("large.txt (+1 -1)");
		expect(rendered).toContain("-30 line-30");
		expect(rendered).toContain("+30 line-30 updated");
		expect(rendered).not.toContain(" 1 line-1");
	});

	it("keeps truncated previews within the configured line and character caps", () => {
		const plainPreview = truncatePreview(
			Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`).join("\n"),
		);
		const oversizedPreview = truncatePreview(`${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`);
		const oversizedChangedHunkPreview = truncatePreview(
			[
				...Array.from({ length: 20 }, (_, index) => ` ${index + 1} line-${index + 1}`),
				`-21 ${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}`,
				"+21 changed",
			].join("\n"),
		);

		expect(plainPreview.split("\n")).toHaveLength(PATCH_PREVIEW_MAX_LINES);
		expect(oversizedPreview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(oversizedPreview).toContain("…");
		expect(oversizedChangedHunkPreview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(oversizedChangedHunkPreview.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
	});

	it("renders expanded patch previews with OpenCode-like highlighted diff rows", () => {
		const rendered = renderPatchPreview(
			{
				files: [
					{
						filePath: "src/foo.ts",
						operation: "update",
						diff: "-1 alpha old\n+1 alpha new\n 2 same",
						added: 1,
						removed: 1,
					},
				],
				added: 1,
				removed: 1,
			},
			"/workspace/project",
			markerTheme as never,
			true,
		);

		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
	});

	it("mutes only context content when requested by a dense preview", () => {
		const rendered = renderToolDiff(" 1 before\n-2 alpha old\n+2 alpha new\n 3 after", {
			filePath: "src/foo.txt",
			theme: markerTheme as never,
			presentation: "dense",
		});

		expect(stripAnsi(rendered).split("\n")).toEqual([
			"<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>1</fg:muted> <fg:muted>before</fg:muted>",
			"<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>2</fg:muted> <fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved></bg:toolErrorBg>",
			"<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>2</fg:muted> <fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded></bg:toolSuccessBg>",
			"<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>3</fg:muted> <fg:muted>after</fg:muted>",
		]);
	});

	it.each([
		{
			inputFormat: "compact",
			diff: " 1 context prose\n-2 same old\n+2 same new\n 3 another context\n-4 removed only\n 5 after removal\n+5 added only",
		},
		{
			inputFormat: "unified",
			diff: "@@ -1,5 +1,5 @@\n context prose\n-same old\n+same new\n another context\n-removed only\n after removal\n+added only",
		},
	] as const)("colors dense $inputFormat Markdown by change status", ({ inputFormat, diff }) => {
		initTheme("dark");
		const rendered = renderToolDiff(diff, {
			filePath: "src/guide.md",
			theme,
			presentation: "dense",
			inputFormat,
		});

		expect(rendered).toContain(theme.fg("text", "context prose"));
		expect(rendered).toContain(theme.fg("toolDiffRemoved", `same ${theme.inverse("old")}`));
		expect(rendered).toContain(theme.fg("toolDiffAdded", `same ${theme.inverse("new")}`));
		expect(rendered).toContain(theme.fg("toolDiffRemoved", "removed only"));
		expect(rendered).toContain(theme.fg("toolDiffAdded", "added only"));
	});

	it("uses diff foregrounds for standalone TypeScript changes in a dense preview", () => {
		initTheme("dark");
		const removed = 'const removed = "old";';
		const added = 'const added = "new";';
		const diff = `-1 ${removed}\n 2 const context = true;\n+2 ${added}`;
		const rendered = renderToolDiff(diff, { filePath: "src/code.ts", theme, presentation: "dense" });
		const [removedRow, , addedRow] = rendered.split("\n");

		expect(removedRow).toContain(theme.fg("toolDiffRemoved", removed));
		expect(addedRow).toContain(theme.fg("toolDiffAdded", added));
	});

	it("renders partial progress previews with realtime pending status", () => {
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch (1/2)..." }],
			details: {
				progress: { applied: 1, failed: 0, total: 2 },
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			markerTheme as never,
			createRenderContext("/workspace/project", { input: "" }, { executionStarted: true, argsComplete: true }),
		);
		const rendered = component?.render(200).join("\n") ?? "";

		expect(rendered).toContain("<bg:toolPendingBg>");
		expect(rendered).toContain("<bold>Applying patch (1/2)</bold>");
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
	});

	it("preserves the outer success background after highlighted diff row resets", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applied patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+1 const value = 1;",
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			ansiTheme as never,
			createRenderContext("/workspace/project", { input: "" }, { executionStarted: true, argsComplete: true }),
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain(`${bgReset}${successBg}`);
	});
});
