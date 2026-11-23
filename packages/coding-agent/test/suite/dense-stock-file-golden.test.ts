import { isSemanticDensityCardSource } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { editRenderers } from "../../src/core/tools/renderers/edit.ts";
import { writeRenderers } from "../../src/core/tools/renderers/write.ts";
import { createWriteDetails } from "../../src/core/tools/write-result.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const markedTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

describe("dense stock file rendering", () => {
	it.each([
		[{ kind: "missing" as const }, "added"],
		[{ kind: "present" as const, content: "old\n" }, "edited"],
	])("uses the write producer's operation and patch", (baseline, kind) => {
		initTheme("dark");
		const args = { path: "src/example.txt", content: "new\n" };
		const component = writeRenderers.renderResult?.(
			{
				content: [{ type: "text", text: "success" }],
				details: createWriteDetails(args.path, args.content, baseline),
			},
			{ expanded: true, isPartial: false },
			theme,
			{ args, cwd: "/workspace", state: {}, isError: false, executionStarted: true } as never,
		);
		expect(component && isSemanticDensityCardSource(component)).toBe(true);
		if (!component || !isSemanticDensityCardSource(component)) throw new Error("missing density source");
		const view = component.renderDensityCard(120, { grouped: false, expanded: true });
		expect(view?.format).toBe("structured");
		if (!view || view.format !== "structured") throw new Error("missing structured view");
		expect(view.kind).toBe(kind);
		expect(view.expandedHeading?.details).toEqual([
			[{ text: "src/example.txt", link: "file:///workspace/src/example.txt" }],
		]);
		const body = view.body.flatMap((block) => (block.type === "rich" ? block.render(120) : [])).join("\n");
		expect(stripAnsi(body)).toContain("+new");
	});

	it("mutes unchanged rows in a dense edit result and keeps diff signs colored", () => {
		const component = editRenderers.renderResult?.(
			{
				content: [{ type: "text", text: "success" }],
				details: { diff: " 1 unchanged\n-2 old\n+2 new", patch: "", firstChangedLine: 2 },
			},
			{ expanded: true, isPartial: false },
			markedTheme as never,
			{
				args: { path: "src/example.txt" },
				cwd: "/workspace",
				state: {},
				isError: false,
				executionStarted: true,
			} as never,
		);
		if (!component || !isSemanticDensityCardSource(component)) throw new Error("missing density source");
		const view = component.renderDensityCard(120, { grouped: false, expanded: true });
		if (!view || view.format !== "structured") throw new Error("missing structured view");
		const body = view.body.flatMap((block) => (block.type === "rich" ? block.render(120) : [])).join("\n");

		expect(stripAnsi(body)).toContain("<fg:muted>unchanged</fg:muted>");
		expect(body).toContain("<fg:toolDiffRemoved>-</fg:toolDiffRemoved>");
		expect(body).toContain("<fg:toolDiffAdded>+</fg:toolDiffAdded>");
	});

	it("mutes unchanged write patch rows while keeping change signs colored", () => {
		const args = { path: "src/example.txt", content: "keep\nnew\n" };
		const component = writeRenderers.renderResult?.(
			{
				content: [{ type: "text", text: "success" }],
				details: createWriteDetails(args.path, args.content, { kind: "present", content: "keep\nold\n" }),
			},
			{ expanded: true, isPartial: false },
			markedTheme as never,
			{
				args,
				cwd: "/workspace",
				state: {},
				isError: false,
				executionStarted: true,
			} as never,
		);
		if (!component || !isSemanticDensityCardSource(component)) throw new Error("missing density source");
		const view = component.renderDensityCard(120, { grouped: false, expanded: true });
		if (!view || view.format !== "structured") throw new Error("missing structured view");
		const body = view.body.flatMap((block) => (block.type === "rich" ? block.render(120) : [])).join("\n");
		const plainBody = stripAnsi(body);

		expect(plainBody).toContain("@@ -1,2 +1,2 @@");
		expect(plainBody).toContain("<fg:muted>keep</fg:muted>");
		expect(plainBody).toContain("<inverse>old</inverse>");
		expect(plainBody).toContain("<inverse>new</inverse>");
		expect(plainBody).toContain("<fg:toolDiffRemoved>-</fg:toolDiffRemoved>");
		expect(plainBody).toContain("<fg:toolDiffAdded>+</fg:toolDiffAdded>");
		expect(plainBody).toContain("<bg:toolErrorBg>");
		expect(plainBody).toContain("<bg:toolSuccessBg>");
	});

	it("shows the actual failure instead of a preview", () => {
		initTheme("dark");
		const component = editRenderers.renderResult?.(
			{ content: [{ type: "text", text: "permission denied" }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{ args: { path: "a.txt" }, cwd: "/workspace", state: {}, isError: true, executionStarted: true } as never,
		);
		expect(component && isSemanticDensityCardSource(component)).toBe(true);
		if (!component || !isSemanticDensityCardSource(component)) throw new Error("missing density source");
		const view = component.renderDensityCard(120, { grouped: false, expanded: true });
		expect(view?.format).toBe("structured");
		if (!view || view.format !== "structured") throw new Error("missing structured view");
		expect(view.status).toBe("failed");
		expect(view.body).toEqual([{ type: "text", lines: ["permission denied"] }]);
	});
});
