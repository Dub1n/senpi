import { Box, stripTerminalSequences, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { buildNoticeBox, noticeEntryRenderer, noticeMessageRenderer } from "../../src/core/extensions/notice/index.ts";
import { CustomEntryComponent } from "../../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { ToolDensityRow } from "../../src/modes/interactive/components/tool-density-row.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";

const entry: CustomEntry = {
	type: "custom",
	id: "notice-entry",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: "goal-cache-warmup",
};

const message: CustomMessage = {
	role: "custom",
	customType: "memory-notice",
	content: "saved",
	display: true,
	timestamp: 0,
};

describe("notice density cards", () => {
	beforeAll(() => initTheme("dark"));

	it("adapts cache-warm entries and project-rule messages while keeping the full title available", () => {
		const cacheWarm = new CustomEntryComponent(
			entry,
			noticeEntryRenderer(() => ({
				title: "⚡ Cache-warm wait · iteration 7 · 1 wake source on duty",
				why: "The wake source is still active.",
			})),
		);
		const projectRules = new CustomMessageComponent(
			message,
			noticeMessageRenderer(() => ({
				title: "● Project rules · /project/AGENTS.md",
				why: "Two instructions matched.",
			})),
		);

		expect(cacheWarm.noticeDensityEligible).toBe(true);
		expect(projectRules.noticeDensityEligible).toBe(true);
		expect(cacheWarm.renderDensitySummary(120, false)[0]).toContain(
			"⚡ Cache-warm wait · iteration 7 · 1 wake source on duty",
		);
		expect(projectRules.renderDensitySummary(120, true)[0]).toContain("● Project rules · /project/AGENTS.md");

		const row = new ToolDensityRow(cacheWarm, () => {});
		const narrow = row
			.render(24)
			.map(stripTerminalSequences)
			.find((line) => line.includes("Cache-warm"));
		expect(narrow).toContain("…");
		expect(narrow).toContain("↯");
		expect(visibleWidth(narrow ?? "")).toBe(24);
	});

	it("does not classify arbitrary purple extension boxes or default custom messages", () => {
		const purpleBox = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		purpleBox.addChild(new Text("Unrelated extension panel", 0, 0));
		const entryComponent = new CustomEntryComponent(entry, () => purpleBox);
		const messageComponent = new CustomMessageComponent(message);

		expect(entryComponent.noticeDensityEligible).toBe(false);
		expect(messageComponent.noticeDensityEligible).toBe(false);
	});

	it("uses a remembered purple notice title for memory tool density only", () => {
		const ui = new TUI(new VirtualTerminal(80, 24));
		const toolDefinition = {
			renderShell: "self" as const,
			renderCall: () => new Text("", 0, 0),
			renderResult: () =>
				buildNoticeBox(
					{
						title: "● Remembered · Prefers concise reports",
						why: "Keep the report brief.",
					},
					{ expanded: false },
					theme,
				),
		};
		const memory = new ToolExecutionComponent("memory", "memory-call", {}, {}, toolDefinition, ui, process.cwd());
		const other = new ToolExecutionComponent("other", "other-call", {}, {}, toolDefinition, ui, process.cwd());
		memory.updateResult({ content: [], isError: false });
		other.updateResult({ content: [], isError: false });

		expect(memory.renderNoticeDensitySummary(100)?.[0]).toContain("● Remembered · Prefers concise reports");
		expect(other.renderNoticeDensitySummary(100)).toBeUndefined();
		memory.dispose();
		other.dispose();
	});
});
