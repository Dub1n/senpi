import { stripTerminalSequences, type DensityCardStructuredView } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderKillBashResult } from "../../src/core/extensions/builtin/terminal/tools/render.ts";
import { ToolDensityRow } from "../../src/modes/interactive/components/tool-density-row.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

describe("structured dense card layout", () => {
	beforeAll(() => initTheme("dark"));

	it.each([false, true])("renders rich content lazily and places grouped sections (grouped=%s)", (grouped) => {
		let expanded = false;
		let renders = 0;
		const view: DensityCardStructuredView = {
			format: "structured",
			kind: "bash-output",
			heading: { identity: "21", details: ["done", "2 lines"] },
			body: [
				{
					type: "rich",
					render: () => {
						renders++;
						return ["body"];
					},
				},
			],
			sections: [{ placement: "grouped", heading: { label: "calls" }, body: [{ type: "text", lines: ["nested"] }] }],
		};
		const card = {
			get densityExpanded() {
				return expanded;
			},
			setExpanded(value: boolean) {
				expanded = value;
			},
			getBackgroundPainter: () => undefined,
			renderDensitySummary: () => [],
			renderDensityCard: () => view,
			render: () => ["default"],
			invalidate() {},
		};
		const row = new ToolDensityRow(card, () => {});
		row.setLayout(grouped, true, true);
		const folded = row.render(32).map(stripTerminalSequences).join("\n");
		expect(folded).toContain("bash 21 • done · 2 lines");
		expect(renders).toBe(0);
		card.setExpanded(true);
		const open = row.render(32).map(stripTerminalSequences);
		expect(renders).toBe(1);
		expect(open.some((line) => line.includes("│ body"))).toBe(true);
		expect(open.some((line) => line.includes("├─ calls"))).toBe(grouped);
		const closing = open.findIndex((line) => line.includes("╰─"));
		const nested = open.findIndex((line) => line.includes("nested"));
		expect(grouped ? nested < closing : nested > closing).toBe(true);
	});

	it.each([
		{ kind: "task", heading: {}, expected: "! task • pending" },
		{ kind: "task", heading: { details: [""] }, expected: "! task • pending" },
		{ kind: "task", heading: { details: ["worker"] }, expected: "! task • worker · pending" },
		{ kind: "eval", heading: { description: "running analysis" }, expected: "! running analysis · pending" },
	] satisfies readonly {
		kind: DensityCardStructuredView["kind"];
		heading: DensityCardStructuredView["heading"];
		expected: string;
	}[])("places status after the existing heading details for $kind", ({ kind, heading, expected }) => {
		const card = {
			densityExpanded: false,
			setExpanded() {},
			getBackgroundPainter: () => undefined,
			renderDensitySummary: () => [],
			renderDensityCard: (): DensityCardStructuredView => ({
				format: "structured",
				kind,
				heading,
				status: "pending",
				statusGlyph: "!",
				body: [],
				sections: [],
			}),
			render: () => [],
			invalidate() {},
		};
		const row = new ToolDensityRow(card, () => {});
		expect(row.render(60).map(stripTerminalSequences).join("\n")).toContain(expected);
	});

	it("does not show the success acknowledgment for a partial empty kill result", () => {
		const component = renderKillBashResult(
			{ content: [], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{
				args: { bash_id: "bash_21" },
				toolCallId: "kill-21",
				invalidate() {},
				lastComponent: undefined,
				state: {},
				cwd: "/workspace",
				executionStarted: true,
				argsComplete: true,
				isPartial: true,
				expanded: false,
				showImages: false,
				imageProtocol: null,
				isError: false,
				hasResult: true,
				spinnerFrame: 0,
			},
		);
		if (!("renderDensityCard" in component)) throw new TypeError("Expected a kill result card");
		const view = component.renderDensityCard();
		if (!view || view.format !== "structured") throw new TypeError("Expected a structured kill result card");
		expect(view.status).toBe("running");
		expect(view.heading.details).toEqual(["killing"]);
		expect(view.body).toEqual([]);
	});
});
