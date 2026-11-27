import { dispatchMouseEvent, getLineSources, setLineSources, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { renderGoalToolResult } from "../../src/core/extensions/builtin/goal/renderers.ts";
import { renderBashOutputCall } from "../../src/core/extensions/builtin/terminal/tools/render.ts";
import { ToolExecutionRenderer } from "../../src/modes/interactive/components/tool-execution-renderer.ts";
import type {
	ToolExecutionRenderState,
	ToolRenderers,
} from "../../src/modes/interactive/components/tool-execution-types.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

function finished(args: unknown, isError = false): ToolExecutionRenderState {
	return {
		args,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		spinnerFrame: undefined,
		result: { content: [{ type: "text", text: "result content" }], isError },
	};
}

function renderTool(
	toolName: string,
	state: ToolExecutionRenderState,
	toolDefinition?: ToolRenderers,
	onToggleExpanded?: () => boolean,
): ToolExecutionRenderer {
	const renderer = new ToolExecutionRenderer(
		{ toolName, toolCallId: "card", cwd: process.cwd(), toolDefinition },
		state,
		() => {},
		onToggleExpanded,
	);
	renderer.update(state);
	return renderer;
}

function firstHeading(lines: string[]): string | undefined {
	return lines.map((line) => stripAnsi(line).trim()).find(Boolean);
}

describe("Default tool card icons", () => {
	beforeAll(() => initTheme("dark"));

	test("adds an explicit Dense-default icon to a stock title and restores exact Default bytes when cleared", () => {
		const renderer = renderTool("read", finished({ path: "example.txt" }));
		const original = renderer.render(30);

		renderer.setToolCardIconOverrides({ read: "✓" });
		expect(firstHeading(renderer.render(30))).toBe("✓ read example.txt");

		renderer.setToolCardIconOverrides(undefined);
		expect(renderer.render(30)).toEqual(original);
	});

	test("replaces the shell marker instead of prepending a second glyph", () => {
		const renderer = renderTool("bash", finished({ command: "printf one" }));
		renderer.setToolCardIconOverrides({ shell: "◆" });

		expect(firstHeading(renderer.render(40))).toBe("◆ printf one");
	});

	test("replaces a goal result's existing status glyph without changing its objective", () => {
		const state = finished({});
		const renderer = renderTool(
			"get_goal",
			{
				...state,
				result: {
					content: [],
					isError: false,
					details: {
						goal: {
							status: "active",
							objective: "Retain this goal",
							tokensUsed: 3,
							timeUsedSeconds: 4,
							createdAt: 0,
							updatedAt: 0,
						},
					},
				},
			},
			{ renderResult: renderGoalToolResult },
		);
		renderer.setToolCardIconOverrides({ "goal.active": "◆" });

		const lines = renderer.render(60);
		expect(lines.map((line) => stripAnsi(line).trim())).toEqual(
			expect.arrayContaining(["◆ active • 3 tokens • 4s", "Retain this goal"]),
		);
	});

	test("uses Bash output process metadata, rather than output text, to pick the stopped icon", () => {
		const state = finished({ bash_id: "bash_1" });
		const renderer = renderTool(
			"bash_output",
			{
				...state,
				result: {
					content: [{ type: "text", text: "a body line" }],
					isError: false,
					details: {
						bashOutput: {
							sessionId: "bash_1",
							processStatus: "killed",
							exitCode: null,
							statusStart: 0,
							statusEnd: 14,
						},
					},
				},
			},
			{ renderCall: renderBashOutputCall },
		);
		renderer.setToolCardIconOverrides({ "bash-output": "✓", "bash-output.killed": "◆" });

		expect(firstHeading(renderer.render(60))).toBe("◆ bash_output bash_1");
	});

	test("applies the failed override to a host-owned generic heading and preserves its click box", () => {
		const onToggle = vi.fn(() => true);
		const renderer = renderTool("unknown_tool", finished({ name: "test" }, true), undefined, onToggle);
		renderer.setToolCardIconOverrides({ tool: "✓", "tool.failed": "猫" });

		const lines = renderer.render(28);
		expect(firstHeading(lines)).toBe("猫 unknown_tool");
		expect(lines.map(visibleWidth)).toEqual(lines.map(() => 28));
		expect(
			dispatchMouseEvent(renderer, {
				type: "click",
				button: "left",
				x: 1,
				y: 1,
				screenX: 1,
				screenY: 1,
				width: 28,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
			}),
		).toMatchObject({ handled: true });
		expect(onToggle).toHaveBeenCalledOnce();
	});

	test("does not wrap or rewrite a custom renderer's selection-bearing output", () => {
		const width = 24;
		const body = new Text("custom title", 0, 0);
		const lines = body.render(width);
		setLineSources(lines, [null]);
		const renderer = renderTool("read", finished({ path: "example.txt" }), {
			renderShell: "self",
			renderCall: () => body,
			renderResult: () => new Text("", 0, 0),
		});

		renderer.setToolCardIconOverrides({ read: "猫", tool: "✓" });
		const painted = renderer.render(width);

		expect(painted).toEqual(lines);
		expect(getLineSources(painted)).toEqual([null]);
	});
});
