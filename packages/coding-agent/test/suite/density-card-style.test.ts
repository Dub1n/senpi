import {
	Box,
	type DensityCardStructuredView,
	nextRenderRevision,
	parseColor,
	setLineSources,
	stripTerminalSequences,
	styleText,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { beforeAll, describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../../../senpi-codemode/src/tool/render.ts";
import { resolveSourceSelection } from "../../../tui/src/selection-source.ts";
import { linearRanges } from "../../../tui/src/source-ranges.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { renderTodoCall, renderTodoResult } from "../../src/core/extensions/builtin/todotools/tools/todo-card.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolDensityRow } from "../../src/modes/interactive/components/tool-density-row.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const width = 40;
const colorCases = (
	[
		{ colorFrames: false, colorNames: false, frame: "borderMuted", name: "toolTitle" },
		{ colorFrames: true, colorNames: false, frame: "customMessageLabel", name: "toolTitle" },
		{ colorFrames: false, colorNames: true, frame: "borderMuted", name: "customMessageLabel" },
		{ colorFrames: true, colorNames: true, frame: "customMessageLabel", name: "customMessageLabel" },
	] as const
).flatMap((style) => [
	{ ...style, colorIcons: false, icon: "text" as const },
	{ ...style, colorIcons: true, icon: "customMessageLabel" as const },
]);

async function terminalRows(rows: readonly string[], cols = width + 1) {
	const terminal = new xterm.Terminal({ cols, rows: 20, allowProposedApi: true });
	await new Promise<void>((resolve) => terminal.write(rows.join("\x1b[0m\r\n"), resolve));
	return { terminal, [Symbol.dispose]: () => terminal.dispose() };
}

function cellOf({ terminal }: Awaited<ReturnType<typeof terminalRows>>, row: number, column: number) {
	const cell = terminal.buffer.active.getLine(row)?.getCell(column);
	if (!cell) throw new TypeError(`Missing terminal cell ${row},${column}`);
	return {
		color: [cell.getFgColorMode(), cell.getFgColor()],
		background: [cell.getBgColorMode(), cell.getBgColor()],
		bold: Boolean(cell.isBold()),
		italic: Boolean(cell.isItalic()),
		strike: Boolean(cell.isStrikethrough()),
	};
}

describe("semantic density card styling", () => {
	beforeAll(() => initTheme("dark"));

	it.each([{ colorIcons: false }, { colorIcons: true }, { colorIcons: true, override: "#5e9ad6" }])(
		"takes the remembered glyph color from the host (icons=$colorIcons, override=$override)",
		async ({ colorIcons, override }) => {
			const card = {
				densityExpanded: false,
				setExpanded() {},
				getBackgroundPainter: () => undefined,
				renderDensitySummary: () => [],
				renderDensityCard: () => ({
					kind: "memory" as const,
					name: "remembered",
					title: " · recovered context",
					statusGlyph: theme.fg("success", "●"),
					renderContent: () => [],
					sections: [],
				}),
				render: () => [],
				invalidate() {},
			};
			const row = new ToolDensityRow(
				card,
				() => {},
				() => ({
					colorIcons,
					colorFrames: true,
					colorNames: true,
					...(override ? { overrides: new Map([["remembered", parseColor(override)]]) } : {}),
				}),
			);
			using rendered = await terminalRows(row.render(width));
			using expected = await terminalRows([
				override
					? styleText("●", { fg: parseColor(override) }, theme.getColorMode())
					: theme.fg(colorIcons ? "customMessageLabel" : "text", "●"),
			]);
			expect(cellOf(rendered, 2, 4).color).toEqual(cellOf(expected, 0, 0).color);
			expect(cellOf(rendered, 2, 6).color).toEqual(cellOf(rendered, 2, 1).color);
			using dim = await terminalRows([theme.fg("dim", "x")]);
			const line = stripTerminalSequences(row.render(width)[2]);
			for (const column of [line.indexOf("·"), line.indexOf("recovered")]) {
				expect(cellOf(rendered, 2, column).color).toEqual(cellOf(dim, 0, 0).color);
			}
		},
	);

	describe.each(["compact", "grouped"] as const)("%s", (density) => {
		it.each([
			{ op: "drop", status: "abandoned", glyph: "×", strike: false },
			{ op: "done", status: "completed", glyph: "✓", strike: true },
		] as const)("renders $status todo descriptions upright and dim", async ({ op, status, glyph, strike }) => {
			const task = "Review changes";
			const card = new ToolExecutionComponent(
				"todo",
				"todo-close",
				{ op, task },
				{},
				{ renderShell: "self", renderCall: renderTodoCall, renderResult: renderTodoResult },
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				card.updateResult({
					content: [{ type: "text", text: "Checklist updated." }],
					details: { op, storage: "memory", phases: [{ name: "Review", tasks: [{ content: task, status }] }] },
					isError: false,
				});
				const row = new ToolDensityRow(card, () => {});
				row.setLayout(density === "grouped", true, true);
				for (const [expanded, frame] of [
					[false, "╶─"],
					[true, "╭─"],
				] as const) {
					card.setExpanded(expanded);
					const rows = row.render(width);
					expect(stripTerminalSequences(rows[2]).trimEnd()).toBe(` ${frame} ${glyph} todo • ${task}`);
					using rendered = await terminalRows(rows);
					using dim = await terminalRows([theme.fg("dim", "x")]);
					for (const column of [6, 11]) {
						expect(cellOf(rendered, 2, column)).toMatchObject({ italic: false, strike: false });
					}
					for (const column of [13, 13 + task.length - 1]) {
						expect(cellOf(rendered, 2, column)).toMatchObject({
							italic: false,
							strike,
							color: cellOf(dim, 0, 0).color,
						});
					}
				}
			} finally {
				card.dispose();
			}
		});

		it.each([
			{ status: "pending", isError: false, glyph: "?" },
			{ status: "answered", isError: false, glyph: "?" },
			{ status: "cancelled", isError: false, glyph: "×" },
			{ status: undefined, isError: true, glyph: "✗" },
		])("uses a stable question heading in both views ($status)", ({ status, isError, glyph }) => {
			const card = new ToolExecutionComponent(
				"request_user_input",
				"question-state",
				{},
				{},
				undefined,
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				const content = "The question service returned this message.";
				card.updateResult({ content: [{ type: "text", text: content }], details: { status }, isError });
				const row = new ToolDensityRow(card, () => {});
				row.setLayout(density === "grouped", true, true);
				const heading = `${glyph} question • ${status ?? "failed"}`;
				expect(row.render(76).map(stripTerminalSequences).join("\n")).toContain(`╶─ ${heading}`);
				card.setExpanded(true);
				const expanded = row.render(76).map(stripTerminalSequences);
				expect(expanded.join("\n")).toContain(`╭─ ${heading}`);
				expect(expanded.filter((line) => line.trim().startsWith("│")).map((line) => line.trim())).toEqual([
					`│ ${content}`,
				]);
			} finally {
				card.dispose();
			}
		});

		it.each([false, true])(
			"dims task models and italicizes previews without tinting identity (batch=%s)",
			async (batch) => {
				const first = {
					task_id: "st_first",
					nickname: "Kale",
					task_summary: "Build a replay",
					status: "running",
					resolved_model: { display: "Luna", reasoning: "high" },
				};
				const second = { ...first, task_id: "st_second", nickname: "Io", task_summary: "Check the replay" };
				const card = new ToolExecutionComponent(
					"task",
					"preview-style",
					{},
					{},
					undefined,
					new TUI(new VirtualTerminal()),
					process.cwd(),
				);
				try {
					card.updateResult({
						content: [],
						details: { ...first, mode: "spawn", ...(batch ? { items: [first, second] } : {}) },
						isError: false,
					});
					const row = new ToolDensityRow(card, () => {});
					row.setLayout(density === "grouped", true, true);
					using swatch = await terminalRows([
						theme.fg("text", "T"),
						theme.style("D", { fg: "dim", italic: true }),
					]);
					for (const expanded of [false, true]) {
						card.setExpanded(expanded);
						const rendered = row.render(80);
						using terminal = await terminalRows(rendered, 81);
						const plain = rendered.map(stripTerminalSequences);
						for (const preview of batch
							? expanded
								? ["Build a replay", "Check the replay"]
								: []
							: ["Build a replay"]) {
							const y = plain.findIndex((line) => line.includes(`"${preview}"`));
							expect(y).toBeGreaterThanOrEqual(0);
							const previewColumn = plain[y].indexOf(preview);
							const modelColumn = plain[y].indexOf("Luna");
							const terminalLine = terminal.terminal.buffer.active.getLine(y);
							expect(terminalLine?.getCell(previewColumn)?.isDim()).toBe(
								swatch.terminal.buffer.active.getLine(1)?.getCell(0)?.isDim(),
							);
							expect(cellOf(terminal, y, previewColumn)).toMatchObject({
								italic: true,
								color: cellOf(swatch, 1, 0).color,
							});
							expect(cellOf(terminal, y, modelColumn)).toMatchObject({
								italic: false,
								color: cellOf(swatch, 1, 0).color,
							});
							expect(terminalLine?.getCell(modelColumn)?.isDim()).toBe(
								swatch.terminal.buffer.active.getLine(1)?.getCell(0)?.isDim(),
							);
							const identity = preview === "Build a replay" ? "Kale" : "Io";
							expect(cellOf(terminal, y, plain[y].indexOf(identity))).toMatchObject({
								italic: false,
								color: cellOf(swatch, 0, 0).color,
							});
						}
					}
				} finally {
					card.dispose();
				}
			},
		);

		it("keeps the failed memory title and the expanded diagnostics", () => {
			const card = new ToolExecutionComponent(
				"memory",
				"memory-failure",
				{},
				{},
				{
					renderShell: "self",
					renderResult: (_result, options) => {
						const notice = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
						notice.addChild(new Text("○ Not remembered", 0, 0));
						notice.addChild(new Text("The request had no new string.", 0, 0));
						if (options.expanded) notice.addChild(new Text("memory: missing new_string", 0, 0));
						return notice;
					},
				},
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				card.updateResult({ content: [{ type: "text", text: "memory: missing new_string" }], isError: true });
				const row = new ToolDensityRow(card, () => {});
				row.setLayout(density === "grouped", true, true);
				expect(row.render(76).map(stripTerminalSequences).join("\n")).toContain("╶─ ✗ memory · not remembered");
				card.setExpanded(true);
				const expanded = row.render(76).map(stripTerminalSequences).join("\n");
				expect(expanded).toContain("╭─ ✗ memory · not remembered");
				expect(expanded).toContain("│ The request had no new string.");
				expect(expanded).toContain("│ memory: missing new_string");
			} finally {
				card.dispose();
			}
		});

		it.each([
			{ summary: "Validate the request", title: "Validate the request" },
			{ summary: undefined, title: "eval js" },
		])("frames eval validation failures as $title without a semantic result renderer", ({ summary, title }) => {
			const card = new ToolExecutionComponent(
				"eval",
				"eval-validation",
				{ language: "js", summary },
				{},
				{
					renderShell: "self",
					renderResult: (result) =>
						new Text(
							result.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
							0,
							0,
						),
				},
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				card.updateResult({
					content: [
						{
							type: "text",
							text: 'Validation failed for tool "eval":\n  - code: required\n\nReceived arguments:\n{\n  "language": "js"\n}',
						},
					],
					isError: true,
				});
				const row = new ToolDensityRow(card, () => {});
				row.setLayout(density === "grouped", true, true);
				expect(row.render(80).map(stripTerminalSequences).join("\n")).toContain(`╶─ ✗ ${title}`);
				card.setExpanded(true);
				const expanded = row.render(80).map(stripTerminalSequences).join("\n");
				expect(expanded).toContain(`╭─ ✗ ${title}`);
				expect(expanded).toContain('│ Validation failed for tool "eval":');
				expect(expanded).toContain('│   "language": "js"');
			} finally {
				card.dispose();
			}
		});

		it("colors the output label with the eval override without tinting its body or summary", async () => {
			const summary = "Review result";
			const args = { language: "js", code: 'print("Example payload");', summary };
			const evalAccent = parseColor("#7cbddb");
			const card = new ToolExecutionComponent(
				"eval",
				"eval-section-color",
				args,
				{},
				{ renderShell: "self", renderCall: renderEvalCall, renderResult: renderEvalResult },
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				card.updateResult({
					content: [{ type: "text", text: "Example payload" }],
					details: {
						language: "js",
						summary,
						toolCalls: [],
						cells: [{ language: "js", index: 0, status: "complete", output: "Example payload", code: args.code }],
					},
					isError: false,
				});
				card.setExpanded(true);
				const row = new ToolDensityRow(
					card,
					() => {},
					() => ({
						colorFrames: true,
						colorNames: true,
						colorIcons: true,
						overrides: new Map([["eval", evalAccent]]),
					}),
				);
				row.setLayout(density === "grouped", true, true);
				const rows = row.render(width);
				const plain = rows.map(stripTerminalSequences);
				const title = plain.findIndex((line) => line.startsWith(" ╭─ ✓ "));
				const output = plain.findIndex((line) => line.startsWith(" ├─ output"));
				expect(plain[title]?.trimEnd(), plain.join("\n")).toBe(" ╭─ ✓ Review result");
				expect(plain[output + 1]?.trimEnd()).toBe(" │ Example payload");
				using terminal = await terminalRows(rows);
				using swatch = await terminalRows([
					theme.fg("toolTitle", "N"),
					styleText("N", { fg: evalAccent }, theme.getColorMode()),
					theme.fg("toolOutput", "N"),
				]);
				expect(cellOf(terminal, title, 6).color).toEqual(cellOf(swatch, 0, 0).color);
				expect(cellOf(terminal, output, 4).color).toEqual(cellOf(swatch, 1, 0).color);
				expect(cellOf(terminal, output + 1, 3).color).toEqual(cellOf(swatch, 2, 0).color);
				expect(cellOf(terminal, title, 4).color).toEqual(cellOf(terminal, title, 1).color);
			} finally {
				card.dispose();
			}
		});

		it.each(["eval list", "opaque extension"] as const)("preserves the muted %s frame", async (renderer) => {
			const opaque = renderer === "opaque extension";
			const card = new ToolExecutionComponent(
				"eval",
				"legacy-tool",
				{ action: "list" },
				{},
				opaque
					? {
							renderCall: (_args, palette) =>
								new Text(palette.style("Custom heading", { fg: "warning", italic: true }), 0, 0),
							renderResult: () => new Text("Retained extension body", 0, 0),
						}
					: { renderShell: "self", renderCall: renderEvalCall, renderResult: renderEvalResult },
				new TUI(new VirtualTerminal()),
				process.cwd(),
			);
			try {
				card.updateResult({
					content: [{ type: "text", text: "Original result" }],
					details: { action: "list", cells: [{ state: "completed" }] },
					isError: false,
				});
				const row = new ToolDensityRow(
					card,
					() => {},
					() => ({ colorFrames: true, colorNames: true, colorIcons: false }),
				);
				row.setLayout(density === "grouped", true, true);
				const folded = row.render(width);
				card.setExpanded(true);
				const open = row.render(width);
				expect(folded.map(stripTerminalSequences)).toEqual(
					["", "", ` ╶─ ✓ eval list ${opaque ? "·" : "•"} 1 completed cell`, ""].map((line, i) =>
						i === 0 ? line : line.padEnd(width),
					),
				);
				const expectedOpen = opaque
					? [" ╭─ Custom heading", " │  Retained extension body"]
					: [" ╭─ ✓ eval list", " │ Original result"];
				expect(open.map(stripTerminalSequences)).toEqual(
					["", "", ...expectedOpen, " ╰─", ""].map((line, i) => (i === 0 ? line : line.padEnd(width))),
				);
				using closedTerminal = await terminalRows(folded);
				using openTerminal = await terminalRows(open);
				using swatches = await terminalRows([
					theme.bg("toolSuccessBg", theme.style("N", { fg: "syntaxType", bold: true })),
					theme.bg("toolSuccessBg", theme.fg("text", "D")),
					theme.bg("toolSuccessBg", theme.fg("borderMuted", "F")),
					theme.bg("toolSuccessBg", theme.style("T", { fg: "warning", italic: true })),
				]);
				expect([
					cellOf(closedTerminal, 2, 6),
					cellOf(closedTerminal, 2, 18),
					cellOf(closedTerminal, 2, 1),
					cellOf(openTerminal, 2, 1),
					cellOf(openTerminal, 3, 1),
					cellOf(openTerminal, 4, 1),
					cellOf(openTerminal, 2, opaque ? 4 : 6),
				]).toEqual([0, 1, 2, 2, 2, 2, opaque ? 3 : 0].map((i) => cellOf(swatches, i, 0)));
			} finally {
				card.dispose();
			}
		});

		it.each(colorCases)(
			"paints frame=$colorFrames name=$colorNames icon=$colorIcons independently",
			async (colors) => {
				const chat = new ExplorationTranscriptContainer({
					tailBudget: 10,
					warmChunkSize: 10,
					requestRender: () => {},
				});
				let expanded = false;
				let revision = nextRenderRevision();
				const content = ["content"];
				const source = "**content**";
				setLineSources(content, [{ document: { text: source, enclosures: [] }, ranges: linearRanges(2, 7) }]);
				const card = {
					get densityExpanded() {
						return expanded;
					},
					setExpanded(value: boolean) {
						expanded = value;
						revision = nextRenderRevision();
					},
					getRenderRevision: () => revision,
					getBackgroundPainter: () => (line: string) => theme.bg("toolErrorBg", line),
					renderDensitySummary: () => ["legacy folded title"],
					renderDensityCard: (): DensityCardStructuredView => ({
						format: "structured",
						kind: "incoming-message",
						heading: { details: [[{ text: "agent", role: "text", strikethrough: true }]] },
						expandedHeading: { details: [[{ text: "agent worker", role: "text", italic: true }]] },
						status: "failed",
						body: [
							{ type: "text", lines: ["metadata"], role: "muted" },
							{ type: "rich", render: () => content },
						],
						sections: [
							{
								heading: { kind: "incoming-message", heading: { details: ["section"] }, statusGlyph: "✓" },
								placement: "frame",
								body: [{ type: "text", lines: ["section body"] }],
							},
						],
					}),
					render: () => ["unchanged Default card"],
					invalidate() {},
				};
				try {
					chat.addChild(card);
					chat.setToolDisplayDensity(density);
					chat.render(width); // Seed the folded render cache before changing colors.
					chat.setToolDisplayColors(colors);
					const folded = chat.render(width);
					card.setExpanded(true);
					const open = chat.render(width);
					const expectedOpen = [
						" ╭─ ✗ from • agent worker",
						" │ metadata",
						" │ content",
						" ├─ ✓ from • section",
						" │ section body",
						" ╰─",
					];
					const plain = (rows: readonly string[]) => rows.map(stripTerminalSequences);
					const padded = (line: string) => line.padEnd(width);
					expect({ folded: plain(folded), open: plain(open) }).toEqual({
						folded: ["", padded(""), padded(" ╶─ ✗ from • agent"), padded("")],
						open: ["", padded(""), ...expectedOpen.map(padded), padded("")],
					});

					const background = density === "grouped" ? "toolSuccessBg" : "toolErrorBg";
					const paint = (color: (typeof colors)["frame" | "name" | "icon"], text: string, bold = false) =>
						color === "customMessageLabel"
							? styleText(text, { fg: parseColor("#c4b5fd"), bold }, theme.getColorMode())
							: theme.style(text, { fg: color, bold });
					using swatches = await terminalRows([
						theme.bg(background, paint(colors.frame, "F")),
						theme.bg(background, paint(colors.name, "N", true)),
						theme.bg(background, paint(colors.icon, "G")),
						theme.bg(background, theme.fg("text", "\x1b[9mD\x1b[29m")),
						theme.bg(background, theme.fg("text", "\x1b[3mD\x1b[23m")),
						theme.bg(background, theme.fg("muted", "M")),
						theme.bg(background, theme.fg("dim", "D")),
					]);
					using closedTerminal = await terminalRows(folded);
					using openTerminal = await terminalRows(open);
					const frame = cellOf(swatches, 0, 0);
					const name = cellOf(swatches, 1, 0);
					const status = cellOf(swatches, 2, 0);
					expect([
						cellOf(closedTerminal, 2, 1),
						...expectedOpen.map((_, index) => cellOf(openTerminal, index + 2, 1)),
					]).toEqual(Array.from({ length: 7 }, () => frame));
					expect([cellOf(closedTerminal, 2, 6), cellOf(openTerminal, 2, 6), cellOf(openTerminal, 5, 6)]).toEqual([
						name,
						name,
						name,
					]);
					expect([cellOf(closedTerminal, 2, 4), cellOf(openTerminal, 2, 4)]).toEqual([status, status]);
					expect(cellOf(openTerminal, 5, 4)).toEqual(status);
					expect(cellOf(closedTerminal, 2, 13)).toEqual(cellOf(swatches, 3, 0));
					expect(cellOf(openTerminal, 2, 13)).toEqual(cellOf(swatches, 4, 0));
					expect(cellOf(openTerminal, 3, 3)).toEqual(cellOf(swatches, 5, 0));
					expect(cellOf(openTerminal, 5, 11)).toEqual(cellOf(swatches, 6, 0));
					expect(cellOf(openTerminal, 5, 13)).toEqual(cellOf(swatches, 6, 0));
					expect(resolveSourceSelection(open, [{ row: 4, start: 4, end: 8 }])).toEqual({ text: "onte" });

					chat.setToolDisplayDensity("default");
					expect(chat.render(width)).toEqual(["unchanged Default card"]);
				} finally {
					chat.dispose();
				}
			},
		);
	});
});
