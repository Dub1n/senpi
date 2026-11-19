import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { dispatchMouseEvent, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { isDensityCardSource } from "../../src/modes/interactive/components/tool-density-row.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const HANDOFF =
	"Ask: inspect the patch - wanted: all behavior remains. For you: the answer stays visible. Now: review. Next: report.";

function nativeSearch(status = "completed") {
	return {
		type: "providerNative" as const,
		subtype: "web_search_call",
		raw: {
			status,
			action: {
				query: "private search query",
				sources: [{ title: "Private result", url: "https://example.test/private" }],
			},
		},
	};
}

function cards(component: AssistantMessageComponent, grouped: boolean) {
	return component.getDensityChildren(grouped).filter(isDensityCardSource);
}

function click(y: number, width: number, height: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("assistant density cards", () => {
	it("reuses a grouped provider projection without inserting inter-card spacers", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			fauxAssistantMessage([nativeSearch(), nativeSearch("in_progress")]),
		);

		const projected = component.getDensityChildren(true);
		expect(projected).toHaveLength(2);
		expect(projected.map(isDensityCardSource)).toEqual([true, true]);
		expect(projected[0]).not.toBe(projected[1]);
		expect(component.getDensityChildren(true)).toBe(projected);
		expect(cards(component, true)).toHaveLength(2);
	});

	it("shows compact provider status while withholding queries and URLs until expansion", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(fauxAssistantMessage([nativeSearch()]));
		const [card] = cards(component, false);
		if (!card) throw new Error("missing provider density card");

		const compact = card.renderDensitySummary(120, false).map(stripAnsi);
		expect(compact).toHaveLength(2);
		expect(compact[1]).toBe("status: completed");
		expect(compact.join("\n")).not.toContain("private search query");
		expect(compact.join("\n")).not.toContain("example.test");
	});

	it.each(["compact", "grouped"] as const)("expands provider details from a %s transcript click", (density) => {
		initTheme("dark");
		const transcript = new ExplorationTranscriptContainer({
			tailBudget: 10,
			warmChunkSize: 10,
			requestRender: () => {},
		});
		try {
			transcript.addChild(new AssistantMessageComponent(fauxAssistantMessage([nativeSearch()])));
			transcript.setToolDisplayDensity(density);
			const collapsed = transcript.render(120);
			const row = collapsed.findIndex((line) => line.includes("web_search"));
			expect(row).toBeGreaterThanOrEqual(0);
			expect(dispatchMouseEvent(transcript, click(row, 120, collapsed.length))?.handled).toBe(true);

			const expanded = transcript.render(120).map((line) => stripAnsi(line));
			expect(expanded.find((line) => line.includes("web_search"))).toBeDefined();
			expect(expanded.join("\n")).toContain("private search query");
			expect(expanded.join("\n")).toContain("example.test/private");
		} finally {
			transcript.dispose();
		}
	});

	it("keeps handoffs native in Compact and folds them with their answer in Grouped", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(fauxAssistantMessage(HANDOFF));

		expect(component.getDensityChildren(false)).toEqual([component]);
		const projected = component.getDensityChildren(true);
		const [card] = projected.filter(isDensityCardSource);
		if (!card) throw new Error("missing handoff density card");
		const answer = projected
			.filter((child) => child !== card)
			.flatMap((child) => child.render(120))
			.map(stripAnsi)
			.join("\n");
		expect(answer).toContain("the answer stays visible");
		expect(component.render(120).join("\n")).toContain("the answer stays visible");

		card.setExpanded(true);
		expect(card.render(120).map(stripAnsi).join("\n")).toContain(HANDOFF);
		expect(component.getDensityChildren(false)).toEqual([component]);
		expect(component.render(120).join("\n")).toContain("the answer stays visible");
		expect(cards(component, true)).toHaveLength(1);
	});
});
