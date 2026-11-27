import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ExplorationTranscriptContainer } from "../src/modes/interactive/components/exploration-transcript-container.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderAll(container: Container, width = 220): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showHighReasoningWarning", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test.each(["compact", "grouped"] as const)(
		"coalesces consecutive thinking and warning statuses in %s",
		(density) => {
			const requestRender = vi.fn();
			const chatContainer = new ExplorationTranscriptContainer({
				requestRender,
				tailBudget: 200,
				warmChunkSize: 20,
			});
			chatContainer.setToolDisplayDensity(density);
			chatContainer.setToolDisplayColors({ colorNames: true, colorFrames: true, colorIcons: true });
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				chatContainer,
				ui: { requestRender },
				toolOutputExpanded: false,
			}) as InteractiveMode;
			const status = Reflect.get(InteractiveMode.prototype, "showStatus") as (message: string) => void;
			status.call(mode, "Thinking level: xhigh");
			mode.showHighReasoningWarning({
				provider: "chatgpt-subscription",
				modelId: "gpt-6.2-sol",
				thinkingLevel: "xhigh",
			});
			const heading = chatContainer.render(220).find((line) => line.includes("HIGH-REASONING MODEL WARNING"));
			expect(heading).toBeDefined();
			expect(stripAnsi(heading ?? "")).toContain(
				"╶─ ! HIGH-REASONING MODEL WARNING • chatgpt-subscription/gpt-6.2-sol @ xhigh",
			);
			for (const text of ["HIGH-REASONING MODEL WARNING", "chatgpt-subscription/gpt-6.2-sol @ xhigh"]) {
				const beforeText = (heading ?? "").split(text)[0];
				const foregrounds = beforeText.match(/\x1b\[(?:3[0-9]|9[0-7])(?:;[0-9;]+)?m/g);
				expect(foregrounds?.at(-1)).toBe(theme.getFgAnsi("error"));
			}
			expect(stripAnsi(chatContainer.render(220).join("\n"))).not.toContain("Thinking level: xhigh");

			status.call(mode, "Thinking level: high");
			const after = stripAnsi(chatContainer.render(220).join("\n"));
			expect(after).toContain("╶─ i status • Thinking level: high");
			expect(after).not.toContain("HIGH-REASONING MODEL WARNING");

			chatContainer.setToolDisplayDensity("default");
			const defaultRows = stripAnsi(chatContainer.render(220).join("\n"));
			expect(defaultRows).toContain("⚠ HIGH-REASONING MODEL WARNING - chatgpt-subscription/gpt-6.2-sol @ xhigh");
			expect(defaultRows).toContain("Thinking level: xhigh");
			expect(defaultRows).toContain("Thinking level: high");
		},
	);

	test("renders a scary warning box naming the model+level and urging ultrabrain", () => {
		const fakeThis = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
			showNoticeBox(spec: unknown): void {
				(InteractiveMode as any).prototype.showNoticeBox.call(fakeThis, spec);
			},
		};

		const event = {
			type: "high_reasoning_warning",
			modelId: "gpt-5.6-sol",
			provider: "openai",
			thinkingLevel: "xhigh",
		} as Extract<AgentSessionEvent, { type: "high_reasoning_warning" }>;

		(
			InteractiveMode as unknown as { prototype: { showHighReasoningWarning(this: unknown, event: unknown): void } }
		).prototype.showHighReasoningWarning.call(fakeThis, event);

		expect(fakeThis.chatContainer.children).toHaveLength(2);
		const rendered = stripAnsi(renderAll(fakeThis.chatContainer));
		expect(rendered).toMatch(/WARNING/i);
		expect(rendered).toContain("gpt-5.6-sol");
		expect(rendered).toContain("xhigh");
		expect(rendered).toMatch(/ultrabrain/i);
		expect(rendered).toMatch(/responsibilit/i);
		expect(rendered).toMatch(/stop|loop/i);
	});

	test("reflects the max level for a sol variant when max is selected", () => {
		const fakeThis = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			ui: { requestRender: vi.fn() },
			showNoticeBox(spec: unknown): void {
				(InteractiveMode as any).prototype.showNoticeBox.call(fakeThis, spec);
			},
		};
		const event = {
			type: "high_reasoning_warning",
			modelId: "openai/gpt-5.6-sol-pro",
			provider: "openai",
			thinkingLevel: "max",
		} as Extract<AgentSessionEvent, { type: "high_reasoning_warning" }>;

		(
			InteractiveMode as unknown as { prototype: { showHighReasoningWarning(this: unknown, event: unknown): void } }
		).prototype.showHighReasoningWarning.call(fakeThis, event);

		expect(stripAnsi(renderAll(fakeThis.chatContainer))).toContain("max");
		expect(stripAnsi(renderAll(fakeThis.chatContainer))).toContain("openai/gpt-5.6-sol-pro");
	});
});
