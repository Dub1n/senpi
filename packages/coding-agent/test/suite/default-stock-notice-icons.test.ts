import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { GoalCacheWarmupEntryData } from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { renderGoalCacheWarmupEntry } from "../../src/core/extensions/builtin/goal/cache-warm-renderer.ts";
import type { LoopGuardDetection } from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import type { LoopGuardEscalationDetails } from "../../src/core/extensions/builtin/loop-guard/notice.ts";
import {
	renderLoopGuardEscalation,
	renderLoopGuardNotice,
} from "../../src/core/extensions/builtin/loop-guard/renderer.ts";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../src/core/extensions/session-control-types.ts";
import type { MessageRenderer } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import type { ToolCardIconOverrides } from "../../src/core/tool-card-icons.ts";
import { CustomEntryComponent } from "../../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { renderRemoteDelivery } from "../../src/modes/interactive/components/remote-delivery-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const WIDTH = 100;

function customMessage<T>(customType: string, details: T): CustomMessage<T> {
	return { role: "custom", customType, details, content: "Preserved body.", display: true, timestamp: 0 };
}

function messageCard<T>(message: CustomMessage<T>, renderer: MessageRenderer<T>): CustomMessageComponent {
	return new CustomMessageComponent(message, (_message, options, theme) => renderer(message, options, theme));
}

function expectTitleOnly(
	card: CustomEntryComponent | CustomMessageComponent,
	overrides: ToolCardIconOverrides,
	fixture: { readonly before: string; readonly after: string; readonly denseGlyph: string },
): void {
	const original = card.render(WIDTH);
	const heading = original.findIndex((line) => stripTerminalSequences(line).trimStart().startsWith(fixture.before));
	expect(heading).toBeGreaterThanOrEqual(0);

	card.setToolCardIconOverrides(overrides);
	const updated = card.render(WIDTH);
	expect(
		stripTerminalSequences(updated[heading] ?? "")
			.trimStart()
			.startsWith(fixture.after),
	).toBe(true);
	expect(updated.filter((_, index) => index !== heading)).toEqual(original.filter((_, index) => index !== heading));
	expect(card.renderDensityCard(WIDTH, { grouped: true })).toMatchObject({ statusGlyph: fixture.denseGlyph });

	card.setToolCardIconOverrides(undefined);
	expect(card.render(WIDTH)).toEqual(original);
}

it.each([
	{
		title: "detection",
		card: () =>
			messageCard(
				customMessage<LoopGuardDetection>("loop-guard:notice", {
					kind: "identical",
					toolName: "read",
					count: 3,
					fingerprint: "read-path",
				}),
				renderLoopGuardNotice,
			),
		before: "⚠ Loop guard",
	},
	{
		title: "escalation",
		card: () =>
			messageCard(
				customMessage<LoopGuardEscalationDetails>("loop-guard:escalation", {
					toolName: "read",
					blockedCallCount: 2,
				}),
				renderLoopGuardEscalation,
			),
		before: "! Loop guard",
	},
])("replaces the Loop Guard $title icon and leaves dense warning metadata alone", ({ card, before }) => {
	expectTitleOnly(
		card(),
		{ "loop-guard": "◆", "tool.failed": "✗" },
		{ before, after: "◆ Loop guard", denseGlyph: "!" },
	);
});

it.each([
	{ phase: "scheduled", role: "wait", icon: "猫" },
	{ phase: "resumed", role: "wake", icon: "◆" },
] as const)("replaces the Goal $role lightning glyph with its own override", ({ phase, role, icon }) => {
	const entry: CustomEntry<GoalCacheWarmupEntryData> = {
		type: "custom",
		id: "warm-entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "goal-cache-warmup",
		data: { phase, goalId: "test-goal", delayMs: 90_000, activeMonitorCount: 1 },
	};
	const card = new CustomEntryComponent(entry, (_entry, options, theme) =>
		renderGoalCacheWarmupEntry(entry, options, theme),
	);
	card.setExpanded(true);
	expectTitleOnly(
		card,
		{ wait: "猫", wake: "◆" },
		{
			before: `⚡ Cache-warm ${role}`,
			after: `${icon} Cache-warm ${role}`,
			denseGlyph: "↯",
		},
	);
});

it("adds an explicit Dense-default arrow to the single leading heading of a typed agent delivery", () => {
	const card = new CustomMessageComponent(
		customMessage(SESSION_CONTROL_DELIVERY_TYPE, {
			delivery_id: "delivered-1",
			source: "session_control",
			deliverAs: "followUp",
			sender: { kind: "agent", session_id: "session-1", name: "Planner" },
			display_text: "**Preserved** rich body",
		}),
		renderRemoteDelivery,
	);
	expectTitleOnly(
		card,
		{ "incoming-message": "←" },
		{
			before: "Sent by another agent · Planner",
			after: "← Sent by another agent · Planner",
			denseGlyph: "←",
		},
	);
});

it("marks the leading relay line once and retains the icon after a custom message rebuild", () => {
	const card = new CustomMessageComponent(
		customMessage(SESSION_CONTROL_DELIVERY_TYPE, {
			delivery_id: "relayed-1",
			source: "session_control",
			deliverAs: "followUp",
			sender: { kind: "agent", session_id: "session-1", name: "Planner" },
			remote_origin: { deviceId: "device-1", deviceName: "Laptop" },
			display_text: "Preserved body",
		}),
		renderRemoteDelivery,
	);
	card.setToolCardIconOverrides({ "incoming-message": "猫" });
	card.invalidate();

	const rows = card
		.render(WIDTH)
		.map((line) => stripTerminalSequences(line).trim())
		.filter(Boolean);
	expect(rows).toEqual(["猫 Relayed from device Laptop", "Sent by another agent · Planner", "Preserved body"]);
});

it("leaves non-agent deliveries and unrelated custom renderers byte-for-byte unchanged", () => {
	const commandLine = customMessage(SESSION_CONTROL_DELIVERY_TYPE, {
		delivery_id: "delivered-2",
		source: "session_control",
		deliverAs: "followUp",
		sender: { kind: "command_line", user: "tester" },
		display_text: "from the shell",
	});
	const cards = [
		new CustomMessageComponent(commandLine, renderRemoteDelivery),
		new CustomMessageComponent(commandLine, () => new Text("Custom heading", 0, 0)),
	];
	for (const card of cards) {
		const original = card.render(WIDTH);
		card.setToolCardIconOverrides({ "incoming-message": "猫", "loop-guard": "◆" });
		expect(card.render(WIDTH)).toEqual(original);
	}
});
