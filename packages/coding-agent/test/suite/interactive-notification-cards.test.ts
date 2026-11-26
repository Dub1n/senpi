import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const width = 100;

async function fixture(density: "compact" | "grouped" | "default") {
	const surface = await explorationSurface();
	if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
		surface.cleanup();
		throw new TypeError("Expected the interactive transcript");
	}
	Reflect.deleteProperty(surface.mode, "showStatus");
	surface.chat.setToolDisplayDensity(density);
	return { ...surface, chat: surface.chat };
}

function rows(surface: Awaited<ReturnType<typeof fixture>>): string[] {
	return surface.chat.render(width).map(stripTerminalSequences);
}

function click(surface: Awaited<ReturnType<typeof fixture>>, y: number) {
	return surface.chat.handleMouse({
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: y,
		width,
		height: rows(surface).length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe("interactive notification cards", () => {
	it.each(["compact", "grouped"] as const)("folds hot-reload deferral with its full reason in %s", async (density) => {
		const surface = await fixture(density);
		try {
			const notice = "Hot-reload deferred: active tool is still running\nThe next reload starts after it completes.";
			invoke(surface.mode, "showExtensionNotify", notice, "info");

			const folded = rows(surface);
			const heading = folded.findIndex((line) => line.includes("Ⅱ hot-reload • deferred"));
			expect(heading).toBeGreaterThanOrEqual(0);
			expect(folded.join("\n")).not.toContain("active tool is still running");
			expect(click(surface, heading)?.handled).toBe(true);

			const expanded = rows(surface).join("\n");
			expect(expanded).toContain("active tool is still running");
			expect(expanded).not.toContain("Hot-reload deferred: active tool is still running");
			expect(expanded).toContain("The next reload starts after it completes.");
		} finally {
			surface.cleanup();
		}
	});

	it.each([
		{
			name: "status",
			emit: (surface: Awaited<ReturnType<typeof fixture>>) => invoke(surface.mode, "showStatus", "Status detail."),
			heading: "status • Status detail.",
			body: "Status detail.",
		},
		{
			name: "warning",
			emit: (surface: Awaited<ReturnType<typeof fixture>>) => surface.mode.showWarning("Warning detail."),
			heading: "warning • Warning detail.",
			body: "Warning detail.",
		},
		{
			name: "generic error",
			emit: (surface: Awaited<ReturnType<typeof fixture>>) => surface.mode.showError("Local tool failed."),
			heading: "error • Local tool failed.",
			body: "Local tool failed.",
		},
		{
			name: "managed tool update",
			emit: (surface: Awaited<ReturnType<typeof fixture>>) =>
				invoke(surface.mode, "showManagedToolStatus", { type: "info", message: "ripgrep is ready." }),
			heading: "tool • ripgrep is ready.",
			body: "ripgrep is ready.",
		},
	])("shows $name as a foldable card with its full body", async ({ emit, heading, body }) => {
		const surface = await fixture("compact");
		try {
			emit(surface);
			const folded = rows(surface);
			const headingRow = folded.findIndex((line) => line.includes(heading));
			expect(headingRow).toBeGreaterThanOrEqual(0);
			expect(click(surface, headingRow)?.handled).toBe(true);
			expect(rows(surface).join("\n")).toContain(body);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps the extension error headline and blank stack lines in the expanded card", async () => {
		const surface = await fixture("compact");
		try {
			invoke(surface.mode, "showExtensionError", {
				extensionPath: "/tmp/fixture-extension.ts",
				error: "fixture extension failed",
				stack: "Error: fixture extension failed\n    at run (fixture-extension.ts:1:1)\n\n    at caller (main.ts:2:1)",
			});

			const folded = rows(surface);
			const heading = folded.findIndex((line) => line.includes("extension failure"));
			expect(heading).toBeGreaterThanOrEqual(0);
			expect(click(surface, heading)?.handled).toBe(true);

			const expanded = rows(surface);
			const text = expanded.join("\n");
			expect(text).toContain("fixture extension failed");
			expect(text).toContain("at run (fixture-extension.ts:1:1)");
			expect(text).toContain("at caller (main.ts:2:1)");
			expect(text).toContain("│  ");
		} finally {
			surface.cleanup();
		}
	});

	it("keeps Default hot-reload text unchanged", async () => {
		const surface = await fixture("default");
		try {
			const notice = "Hot-reload deferred: active tool is still running";
			invoke(surface.mode, "showExtensionNotify", notice, "info");
			const text = rows(surface).join("\n");
			expect(text).toContain(notice);
			expect(text).not.toContain("Ⅱ hot-reload • deferred");
		} finally {
			surface.cleanup();
		}
	});
});
