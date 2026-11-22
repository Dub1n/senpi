import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { ToolDensityRow, type DensityCardSource } from "../../src/modes/interactive/components/tool-density-row.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { renderGoalToolResult } from "../../src/core/extensions/builtin/goal/renderers.ts";
import type { GoalToolRenderDetails } from "../../src/core/extensions/builtin/goal/format.ts";
import type { GoalToolSnapshot } from "../../src/core/extensions/builtin/goal/types.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const width = 64;

function snapshot(overrides: Partial<GoalToolSnapshot> = {}): GoalToolSnapshot {
	return {
		threadId: "01a04104-22d5-7f13-be4e-ada49243a283",
		objective: "Verify the migration and report the result",
		status: "complete",
		tokensUsed: 731_500,
		timeUsedSeconds: 420,
		createdAt: 1_788_214_524,
		updatedAt: 1_788_214_944,
		...overrides,
	};
}

function padded(line: string): string {
	return line.padEnd(width);
}

function densityRow(result: ReturnType<typeof renderGoalToolResult>): {
	card: DensityCardSource;
	row: ToolDensityRow;
} {
	let expanded = false;
	const card: DensityCardSource = {
		get densityExpanded() {
			return expanded;
		},
		setExpanded(value) {
			expanded = value;
		},
		getBackgroundPainter: () => undefined,
		renderDensitySummary: (available) => result.render(available),
		renderDensityCard: (available, options) =>
			"renderDensityCard" in result ? result.renderDensityCard(available, options) : undefined,
		render: (available) => result.render(available),
		invalidate: () => result.invalidate(),
	};
	const row = new ToolDensityRow(card, () => {});
	row.setLayout(true, true, true);
	return { card, row };
}

describe("goal density card", () => {
	it("renders the recorded outcome and objective in folded and expanded density rows", () => {
		initTheme("dark");
		const details: GoalToolRenderDetails = { goal: snapshot() };
		const component = renderGoalToolResult(
			{ content: [{ type: "text", text: "recorded goal result" }], details },
			{ expanded: false, isPartial: false },
			theme,
		);
		const { card, row } = densityRow(component);
		expect(row.render(width).map(stripTerminalSequences)).toEqual([
			"",
			padded(""),
			padded(" ╶─ ✓ goal complete • 731.5K tokens • 7m"),
			padded(""),
		]);

		card.setExpanded(true);
		expect(row.render(width).map(stripTerminalSequences)).toEqual([
			"",
			padded(""),
			padded(" ╭─ ✓ goal complete • 731.5K tokens • 7m"),
			padded(" │ Verify the migration and report the result"),
			padded(" │ created 2026-08-31T22:15:24.000Z"),
			padded(" │ updated 2026-08-31T22:22:24.000Z"),
			padded(" ╰─"),
			padded(""),
		]);
	});

	it("keeps a recorded blocked goal distinct from a failed update", () => {
		initTheme("dark");
		const component = renderGoalToolResult(
			{
				content: [{ type: "text", text: "recorded blocked goal" }],
				details: {
					goal: snapshot({
						status: "blocked",
						blockedReason: "waiting for an external approval",
					}),
				},
			},
			{ expanded: false, isPartial: false },
			theme,
		);
		const { card } = densityRow(component);
		const view = card.renderDensityCard?.(width, { grouped: true, expanded: false });
		expect(view?.name).toBe("goal");
		expect(view?.kind).toBe("goal");
		expect(view?.title ?? "").toContain("blocked • 731.5K tokens • 7m");
		expect(view?.status).toBe("done");

		const failure = renderGoalToolResult(
			{ content: [{ type: "text", text: "update_goal failed: reason is required" }] },
			{ expanded: false, isPartial: false },
			theme,
		);
		expect(failure.renderDensityCard(width, { grouped: true, expanded: false })).toBeUndefined();
		expect(failure.render(width).map(stripTerminalSequences)).toEqual([
			padded("update_goal failed: reason is required"),
		]);
	});

	it("renders a registered goal update in the grouped transcript", async () => {
		const surface = await explorationSurface(true, [goalExtension]);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			invoke(surface.mode, "renderSessionItems", [
				fauxAssistantMessage(
					{ type: "toolCall", id: "goal-1", name: "update_goal", arguments: { status: "complete" } },
					{ stopReason: "toolUse", timestamp: 0 },
				),
				{
					role: "toolResult",
					toolName: "update_goal",
					toolCallId: "goal-1",
					timestamp: 0,
					isError: false,
					content: [{ type: "text", text: "recorded goal" }],
					details: { goal: snapshot() },
				},
			]);
			surface.chat.setToolDisplayDensity("grouped");
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
				"",
				padded(""),
				padded(" ╭─ ✓ goal complete • 731.5K tokens • 7m"),
				padded(" │ Verify the migration and report the result"),
				padded(" │ created 2026-08-31T22:15:24.000Z"),
				padded(" │ updated 2026-08-31T22:22:24.000Z"),
				padded(" ╰─"),
				padded(""),
			]);
		} finally {
			surface.cleanup();
		}
	});
});
