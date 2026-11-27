import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { TerminalBackgroundAgeEvent } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { createCompactionSummaryMessage } from "../../src/core/messages.ts";
import { CompactionSummaryMessageComponent } from "../../src/modes/interactive/components/compaction-summary-message.ts";
import { NotificationCard, type NotificationKind } from "../../src/modes/interactive/components/notification-card.ts";
import { SystemPromptStatus } from "../../src/modes/interactive/components/system-prompt-status.ts";
import { TerminalBackgroundNotice } from "../../src/modes/interactive/components/terminal-background-notice.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const WIDTH = 72;
const noticeBody = "Follow-up details";

it.each([
	{ kind: "info", role: "system.info", glyph: "i" },
	{ kind: "warning", role: "system.warning", glyph: "!" },
	{ kind: "error", role: "system.error", glyph: "×" },
	{ kind: "tool", role: "tool.notice", glyph: "›" },
	{ kind: "hot-reload", role: "system.deferred", glyph: "Ⅱ" },
] as const satisfies readonly { kind: NotificationKind; role: string; glyph: string }[])(
	"adds an explicitly configured $role icon only to the Default $kind heading",
	({ kind, role, glyph }) => {
		const card = new NotificationCard(kind, "Raw notice", {
			defaultText: () => `${theme.fg("warning", "Custom title")}\n${theme.fg("dim", noticeBody)}`,
		});
		const original = card.render(WIDTH);
		card.setToolCardIconOverrides({ system: "◆", "tool.failed": "✖", [role]: glyph });

		const updated = card.render(WIDTH);
		expect(updated.map((line) => stripTerminalSequences(line).trim())).toEqual([`${glyph} Custom title`, noticeBody]);
		expect(updated[1]).toBe(original[1]);
		expect(card.renderDensityCard(WIDTH, { grouped: true }).statusGlyph).toBe(glyph);

		card.setToolCardIconOverrides(undefined);
		expect(card.render(WIDTH)).toEqual(original);
	},
);

it("keeps the expanded compaction body and restores the exact heading when cleared", () => {
	const card = new CompactionSummaryMessageComponent(
		createCompactionSummaryMessage("Compaction body stays intact.", 1200, new Date(0).toISOString()),
	);
	card.setExpanded(true);
	const original = card.render(WIDTH);
	const selection = card.renderDensityCard(WIDTH, { grouped: true }).heading;
	const revision = card.getRenderRevision();
	card.setToolCardIconOverrides({ compaction: "猫" });

	const updated = card.render(WIDTH);
	const heading = updated.findIndex((line) => stripTerminalSequences(line).includes("[compaction]"));
	expect(stripTerminalSequences(updated[heading] ?? "").trim()).toBe("猫 [compaction]");
	expect(visibleWidth(updated[heading] ?? "")).toBe(WIDTH);
	expect(updated.filter((_, index) => index !== heading)).toEqual(original.filter((_, index) => index !== heading));
	expect(card.getRenderRevision()).not.toBe(revision);
	expect(card.renderDensityCard(WIDTH, { grouped: true }).heading).toEqual(selection);

	card.setToolCardIconOverrides(undefined);
	expect(card.render(WIDTH)).toEqual(original);
});

it("uses the Bash attention icon without replacing the terminal's Default warning label", () => {
	const event: TerminalBackgroundAgeEvent = {
		kind: "reap_failed",
		id: "bash_7",
		description: "watch",
		startedAtMs: 0,
		ageMs: 600_000,
		ageMinutes: 10,
		autoReapMinutes: 10,
		stop: { tool: "kill_bash", args: { bash_id: "bash_7" } },
	};
	const card = new TerminalBackgroundNotice(event, "watch could not be stopped", false);
	const original = card.render(WIDTH);
	card.setToolCardIconOverrides({ "bash-output": "◆", "bash-output.attention": "猫", "system.warning": "!" });

	const updated = card.render(WIDTH);
	expect(stripTerminalSequences(updated[0] ?? "").trim()).toBe("猫 Warning: watch could not be stopped");
	expect(visibleWidth(updated[0] ?? "")).toBe(WIDTH);
	expect(card.renderDensityCard().statusGlyph).toBe("!");

	card.setToolCardIconOverrides(undefined);
	expect(card.render(WIDTH)).toEqual(original);
});

it("uses the ready icon for Default system prompt status without changing grouped metadata", () => {
	const card = new SystemPromptStatus("System prompt: fast");
	const original = card.render(WIDTH);
	card.setToolCardIconOverrides({ system: "✓", "system.info": "i" });

	expect(stripTerminalSequences(card.render(WIDTH)[0] ?? "").trim()).toBe("✓ System prompt: fast");
	expect(card.renderDensityCard(WIDTH, { grouped: false })).toBeUndefined();
	expect(card.renderDensityCard(WIDTH, { grouped: true })).toMatchObject({
		heading: { description: "System prompt: fast" },
		statusGlyph: "✓",
	});

	card.setToolCardIconOverrides(undefined);
	expect(card.render(WIDTH)).toEqual(original);
});
