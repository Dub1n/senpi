import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { registerReadClassifier } from "../../src/core/tools/read-classifiers.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke, runTool } from "./exploration-surface-harness.ts";

const width = 80;
const row = (text: string) => text.padEnd(width, " ");

async function fixture(density: "compact" | "grouped") {
	const surface = await explorationSurface();
	if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
		surface.cleanup();
		throw new TypeError("Expected the interactive transcript");
	}
	surface.chat.setToolDisplayDensity(density);
	return { ...surface, chat: surface.chat };
}

function rows(surface: Awaited<ReturnType<typeof fixture>>) {
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
		height: surface.chat.render(width).length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe("dense consecutive read projection", () => {
	it.each(["compact", "grouped"] as const)("separates mixed skill results from ordinary %s reads", async (density) => {
		const surface = await fixture(density);
		const unregister = registerReadClassifier(({ absolutePath }) =>
			absolutePath.endsWith("manifest.toml") ? { kind: "skill", label: "team/git" } : undefined,
		);
		try {
			await runTool(surface, {
				id: "bun",
				toolName: "read",
				args: { path: "skills/bun/SKILL.md", offset: 1, limit: 2 },
				output: "\n  # Bun\n",
			});
			await runTool(surface, { id: "view", toolName: "todo", args: { op: "view" } });
			await runTool(surface, {
				id: "git",
				toolName: "read",
				args: { path: "skills/git/manifest.toml" },
				output: "File not found",
				isError: true,
			});
			await runTool(surface, { id: "doc", toolName: "read", args: { path: "skills/git/notes.md" } });
			const following = [
				...(density === "compact" ? [row(""), "", row("")] : []),
				row(" ╶─ ✓ read • notes.md"),
				row(""),
			];
			expect.soft(rows(surface)).toEqual(["", row(""), row(" ╶─ ~ skill • bun team/git · 1 failed"), ...following]);
			expect.soft(click(surface, 2)?.handled).toBe(true);
			expect
				.soft(rows(surface))
				.toEqual([
					"",
					row(""),
					row(" ╭─ ✓ skill • bun:1-2"),
					row(" │ "),
					row(" │   # Bun"),
					row(" ├─ ✗ skill • team/git"),
					row(" │ File not found"),
					row(" ╰─"),
					...following,
				]);
		} finally {
			unregister();
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("uses success and shortest unique suffixes in %s", async (density) => {
		const surface = await fixture(density);
		try {
			for (const [id, path] of [
				["one", "one/shared/a.ts"],
				["two", "two/shared/a.ts"],
				["three", "else/b.ts"],
			]) {
				await runTool(surface, { id, toolName: "read", args: { path }, output: id });
			}
			expect(rows(surface)).toEqual([
				"",
				row(""),
				row(" ╶─ ✓ read • one/shared/a.ts two/shared/a.ts b.ts"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a mixed-run failure count visible on a narrow terminal", async () => {
		const surface = await fixture("grouped");
		try {
			await runTool(surface, {
				id: "long",
				toolName: "read",
				args: { path: "a-very-long-filename-for-the-first-read.ts" },
				output: "first",
			});
			await runTool(surface, {
				id: "failed",
				toolName: "read",
				args: { path: "another-very-long-filename.ts" },
				output: "File not found",
				isError: true,
			});
			expect(surface.chat.render(28).map(stripTerminalSequences)).toEqual([
				"",
				" ".repeat(28),
				" ╶─ ~ read • a… · 1 failed  ",
				" ".repeat(28),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("ends a %s read run at intervening prose", async (density) => {
		const surface = await fixture(density);
		try {
			await runTool(surface, { id: "a", toolName: "read", args: { path: "a.ts" }, output: "a" });
			await runTool(surface, { id: "b", toolName: "read", args: { path: "b.ts" }, output: "b" });
			invoke(surface.mode, "addMessageToChat", fauxAssistantMessage("Between reads."));
			await runTool(surface, { id: "c", toolName: "read", args: { path: "c.ts" }, output: "c" });
			await runTool(surface, { id: "d", toolName: "read", args: { path: "d.ts" }, output: "d" });
			expect(rows(surface)).toEqual([
				"",
				row(""),
				row(" ╶─ ✓ read • a.ts b.ts"),
				row(""),
				"",
				row(" Between reads."),
				"",
				row(""),
				row(" ╶─ ✓ read • c.ts d.ts"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)(
		"keeps an open %s run ordered as a pending read settles",
		async (density) => {
			const surface = await fixture(density);
			try {
				await runTool(surface, { id: "a", toolName: "read", args: { path: "a.ts" }, output: "first" });
				await surface.event({
					type: "tool_execution_start",
					toolCallId: "b",
					toolName: "read",
					args: { path: "b.ts" },
				});
				expect.soft(rows(surface)).toEqual(["", row(""), row(" ╶─ ~ read • a.ts b.ts"), row("")]);
				expect.soft(click(surface, 2)?.handled).toBe(true);
				expect
					.soft(rows(surface))
					.toEqual([
						"",
						row(""),
						row(" ╭─ ✓ read • a.ts"),
						row(" │ first"),
						row(" ├─ ○ read • b.ts"),
						row(" ╰─"),
						row(""),
					]);
				await surface.event({
					type: "tool_execution_end",
					toolCallId: "b",
					toolName: "read",
					result: { content: [{ type: "text", text: "second" }] },
					isError: false,
				});
				expect
					.soft(rows(surface))
					.toEqual([
						"",
						row(""),
						row(" ╭─ ✓ read • a.ts"),
						row(" │ first"),
						row(" ├─ ✓ read • b.ts"),
						row(" │ second"),
						row(" ╰─"),
						row(""),
					]);
				expect.soft(click(surface, 4)?.handled).toBe(true);
				expect.soft(rows(surface)).toEqual(["", row(""), row(" ╶─ ✓ read • a.ts b.ts"), row("")]);
			} finally {
				surface.cleanup();
			}
		},
	);
});
