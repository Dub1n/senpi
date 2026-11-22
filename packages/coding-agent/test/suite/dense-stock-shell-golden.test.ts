import { stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, runTool } from "./exploration-surface-harness.ts";

describe.each(["compact", "grouped"] as const)("stock shell in %s", (density) => {
	it("renders the original command and preserves indented output when expanded", async () => {
		const surface = await explorationSurface();
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			surface.chat.setToolDisplayDensity(density);
			await runTool(surface, {
				id: "shell",
				toolName: "bash",
				args: { command: "printf hello" },
				output: "  first\n\n    \x1b[31msecond\x1b[0m",
			});
			const rows = () => surface.chat.render(80).map(stripTerminalSequences);
			expect(rows().join("\n")).toContain("✓ bash • printf hello");
			expect(
				surface.chat.handleMouse({
					type: "click",
					button: "left",
					x: 6,
					y: 2,
					screenX: 6,
					screenY: 2,
					width: 80,
					height: rows().length,
					shift: false,
					alt: false,
					ctrl: false,
				})?.handled,
			).toBe(true);
			expect(rows().join("\n")).toContain(" │   first");
			expect(rows().join("\n")).toContain(" │     second");
			const frame = surface.chat.render(80);
			const row = frame.map(stripTerminalSequences).findIndex((line) => line.includes("second"));
			const terminal = new xterm.Terminal({ cols: 81, rows: 40, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) => terminal.write(frame.join("\r\n"), resolve));
				const line = terminal.buffer.active.getLine(row);
				const column = line?.translateToString().indexOf("second") ?? -1;
				const cell = line?.getCell(column);
				expect(cell?.isFgPalette()).toBe(true);
				expect(cell?.getFgColor()).toBe(1);
			} finally {
				terminal.dispose();
			}
		} finally {
			surface.cleanup();
		}
	});

	it("identifies a failed PowerShell call without losing its diagnostic", async () => {
		const surface = await explorationSurface();
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			surface.chat.setToolDisplayDensity(density);
			await runTool(surface, {
				id: "powershell",
				toolName: "powershell",
				args: { command: "throw error", timeout: 7 },
				output: "  diagnostic",
				isError: true,
			});
			const rows = () => surface.chat.render(80).map(stripTerminalSequences);
			expect(rows().join("\n")).toContain("✗ powershell • throw error · timeout 7s");
			expect(
				surface.chat.handleMouse({
					type: "click",
					button: "left",
					x: 6,
					y: 2,
					screenX: 6,
					screenY: 2,
					width: 80,
					height: rows().length,
					shift: false,
					alt: false,
					ctrl: false,
				})?.handled,
			).toBe(true);
			expect(rows().join("\n")).toContain(" │   diagnostic");
		} finally {
			surface.cleanup();
		}
	});
});
