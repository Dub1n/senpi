import { isSemanticDensityCardSource } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { editRenderers } from "../../src/core/tools/renderers/edit.ts";
import { writeRenderers } from "../../src/core/tools/renderers/write.ts";
import { createWriteDetails } from "../../src/core/tools/write-result.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

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
