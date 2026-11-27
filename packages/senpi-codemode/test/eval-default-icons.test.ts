import { initTheme, ToolExecutionComponent } from "@code-yeongyu/senpi";
import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalResultDetails, EvalToolRequest } from "../src/tool/types.ts";
import { stripAnsi } from "./eval-render-fixtures.ts";

const run = { action: "run", language: "js", code: "1 + 1", summary: "count rows" } as const;
const list = { action: "list" } as const;

beforeAll(() => initTheme());

function evalCard(args: EvalToolRequest = run): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"eval",
		"eval-icon",
		args,
		{},
		{ renderCall: renderEvalCall, renderResult: renderEvalResult },
		new TUI(new VirtualTerminal(64, 20)),
		"/tmp",
	);
}

function header(card: ToolExecutionComponent, width = 64): string | undefined {
	return card
		.render(width)
		.map(stripAnsi)
		.map((line) => line.trim())
		.find(Boolean);
}

function cellDetails(status: EvalCellResult["status"]): EvalResultDetails {
	return {
		language: run.language,
		durationMs: 0,
		toolCalls: [],
		truncated: false,
		cells: [{ index: 0, ...run, output: "", status }],
	};
}

it("uses a configured wide Eval icon for the live call and preserves its one-line heading", () => {
	const card = evalCard();
	try {
		card.setToolCardIconOverrides({ eval: "猫" });
		const line = header(card, 38);
		expect(line).toBe("╭─ 猫 count rows · eval js streaming");
		expect(visibleWidth(line ?? "")).toBe(36);
	} finally {
		card.dispose();
	}
});

it.each([
	{ status: "running", isPartial: true, role: "tool.pending", glyph: "◉", lead: "╭─" },
	{ status: "complete", isPartial: false, role: "eval", glyph: "◆", lead: "╶─" },
	{ status: "error", isPartial: false, role: "tool.failed", glyph: "✖", lead: "╶─" },
	{ status: "detached", isPartial: false, role: "tool.detached", glyph: "◇", lead: "╶─" },
	{ status: "cancelled", isPartial: false, role: "tool.cancelled", glyph: "◈", lead: "╶─" },
] as const)("uses the $role override in the $status result heading", ({ status, isPartial, role, glyph, lead }) => {
	const card = evalCard();
	try {
		card.setToolCardIconOverrides({ eval: "◆", [role]: glyph });
		card.updateResult({ content: [], details: cellDetails(status), isError: false }, isPartial);
		expect(header(card)).toMatch(new RegExp(`^${lead} ${glyph} count rows · eval js `, "u"));
	} finally {
		card.dispose();
	}
});

it("leaves a failure distinct when only the Eval success icon is configured", () => {
	const card = evalCard();
	try {
		card.setToolCardIconOverrides({ eval: "◆" });
		card.updateResult({ content: [], details: cellDetails("error"), isError: false });
		expect(header(card)).toBe("╶─ ✗ count rows · eval js error");
	} finally {
		card.dispose();
	}
});

it("uses the failure override for host errors with no cell details", () => {
	const card = evalCard();
	try {
		card.setToolCardIconOverrides({ eval: "◆", "tool.pending": "◉", "tool.failed": "✖" });
		card.updateResult({ content: [{ type: "text", text: "invalid input" }], isError: true });
		expect(header(card)).toBe("✖ eval ? error");
	} finally {
		card.dispose();
	}
});

it("prefixes a list call and result, keeps Dense glyph ownership, and restores exact list bytes when unset", () => {
	const card = evalCard(list);
	try {
		card.setToolCardIconOverrides({ eval: "✓" });
		expect(header(card)).toBe("✓ eval list");
		card.updateResult({
			content: [{ type: "text", text: "one cell" }],
			details: { action: "list", cells: [] } satisfies EvalResultDetails,
			isError: false,
		});
		expect(header(card)).toBe("✓ eval list");
		card.setToolCardIconOverrides(undefined);
		const unconfigured = card.render(64);
		const densityOptions = { grouped: true };
		const density = card.renderDensityCard(64, densityOptions);
		card.setToolCardIconOverrides({ eval: "猫" });
		expect(header(card)).toBe("猫 eval list");
		const overriddenDensity = card.renderDensityCard(64, densityOptions);
		expect(overriddenDensity).toMatchObject({ kind: "eval", heading: { identity: "eval list" }, status: "done" });
		if (density?.format !== "structured" || overriddenDensity?.format !== "structured")
			throw new Error("Expected structured Eval card views");
		expect(overriddenDensity.statusGlyph).toBe(density.statusGlyph);
		card.setToolCardIconOverrides(undefined);
		expect(card.render(64)).toEqual(unconfigured);
	} finally {
		card.dispose();
	}
});

it("keeps a listed failed cell ahead of the general Eval icon", () => {
	const card = evalCard(list);
	try {
		card.setToolCardIconOverrides({ eval: "◆", "tool.failed": "✖" });
		card.updateResult({
			content: [{ type: "text", text: "one failed cell" }],
			details: {
				action: "list",
				cells: [{ cellId: "cell-failed", language: "js", startedAtMs: 0, state: "failed" }],
			} satisfies EvalResultDetails,
			isError: false,
		});
		expect(header(card)).toBe("✖ eval list");
	} finally {
		card.dispose();
	}
});
