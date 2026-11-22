import { nextRenderRevision, setLineSources, stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveSourceSelection } from "../../../tui/src/selection-source.ts";
import { linearRanges } from "../../../tui/src/source-ranges.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const width = 40;
const colorCases = [
	{ colorFrames: false, colorNames: false, frame: "borderMuted", name: "toolTitle" },
	{ colorFrames: true, colorNames: false, frame: "customMessageLabel", name: "toolTitle" },
	{ colorFrames: false, colorNames: true, frame: "borderMuted", name: "customMessageLabel" },
	{ colorFrames: true, colorNames: true, frame: "customMessageLabel", name: "customMessageLabel" },
] as const;

async function terminalRows(rows: readonly string[]) {
	const terminal = new xterm.Terminal({ cols: width + 1, rows: 20, allowProposedApi: true });
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

	describe.each(["compact", "grouped"] as const)("%s", (density) => {
		it.each(colorCases)("paints frames=$colorFrames and names=$colorNames independently", async (colors) => {
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
			// Exercise a real third-party card contract without registering a fixture-specific renderer hook.
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
				renderDensityCard: () => ({
					name: "from",
					kind: "message" as const,
					title: ` · ${theme.fg("error", "\x1b[1;9magent\x1b[22;29m")}`,
					expandedTitle: `: ${theme.fg("warning", "\x1b[1;3magent worker\x1b[22;23m")}`,
					status: "failed" as const,
					metadata: "metadata",
					renderContent: () => content,
					sections: [
						{
							name: "from",
							statusGlyph: theme.fg("success", "✓"),
							label: " section",
							placement: "frame" as const,
							render: () => ["section body"],
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
					" ╭─ ✗ from: agent worker",
					" │ metadata",
					" │ content",
					" ├─ ✓ from section",
					" │ section body",
					" ╰─",
				];
				const plain = (rows: readonly string[]) => rows.map(stripTerminalSequences);
				const padded = (line: string) => line.padEnd(width);
				expect({ folded: plain(folded), open: plain(open) }).toEqual({
					folded: ["", padded(""), padded(" ╶─ ✗ from · agent"), padded("")],
					open: ["", padded(""), ...expectedOpen.map(padded), padded("")],
				});

				const background = density === "grouped" ? "toolSuccessBg" : "toolErrorBg";
				using swatches = await terminalRows([
					theme.bg(background, theme.fg(colors.frame, "F")),
					theme.bg(background, theme.fg(colors.name, "\x1b[1mN\x1b[22m")),
					theme.bg(background, theme.fg("error", "G")),
					theme.bg(background, theme.fg("text", "\x1b[9mD\x1b[29m")),
					theme.bg(background, theme.fg("text", "\x1b[3mD\x1b[23m")),
					theme.bg(background, theme.fg("success", "G")),
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
				expect(cellOf(openTerminal, 5, 4)).toEqual(cellOf(swatches, 5, 0));
				expect(cellOf(closedTerminal, 2, 13)).toEqual(cellOf(swatches, 3, 0));
				expect(cellOf(openTerminal, 2, 12)).toEqual(cellOf(swatches, 4, 0));
				expect(resolveSourceSelection(open, [{ row: 4, start: 4, end: 8 }])).toEqual({ text: "onte" });

				chat.setToolDisplayDensity("default");
				expect(chat.render(width)).toEqual(["unchanged Default card"]);
			} finally {
				chat.dispose();
			}
		});
	});
});
