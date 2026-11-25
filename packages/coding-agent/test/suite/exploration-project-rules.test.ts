import { describe, expect, it } from "vitest";
import { registerRuleActivationRenderer } from "../../src/core/extensions/builtin/rule-activation/index.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, runTool } from "./exploration-surface-harness.ts";

// senpi#2057: a project-rules notice for a read inside an exploration group folds into that group.
function projectRules(toolCallId: string | undefined, rules: string[], targetPath = "src/a.ts") {
	return {
		type: "custom" as const,
		id: `rules-${toolCallId ?? "legacy"}-${rules.join("+")}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "rule-activation",
		data: { kind: "project-rules", targetPath, rules, ...(toolCallId ? { toolCallId } : {}) },
	};
}

async function surfaceWith(notices: Array<ReturnType<typeof projectRules>>, afterIndex: number[]) {
	const surface = await explorationSurface(true, [registerRuleActivationRenderer]);
	const reads = ["src/a.ts", "src/b.ts", "src/c.ts"];
	for (const [index, path] of reads.entries()) {
		await runTool(surface, { id: `read-${index}`, toolName: "read", args: { path } });
		for (const [n, at] of afterIndex.entries()) {
			if (at === index) await surface.event({ type: "entry_appended", entry: notices[n] } as never);
		}
	}
	return surface;
}

describe("project rules inside an exploration group", () => {
	it("folds matching notices into one Explored cell with an English rules line", async () => {
		const surface = await surfaceWith(
			[projectRules("read-0", ["AGENTS.md"]), projectRules("read-1", ["AGENTS.md", "src/AGENTS.md"])],
			[0, 1],
		);
		try {
			const text = surface.text();
			expect(text.match(/Explored/g)).toHaveLength(1);
			expect(text).toContain("Read a.ts, b.ts, c.ts");
			expect(text).toContain("Applied 2 project rules");
			expect(text).not.toContain("Project rules ·");
		} finally {
			surface.cleanup();
		}
	});

	it.each([
		["a legacy notice without a tool call id", projectRules(undefined, ["AGENTS.md"])],
		["a notice for a call outside the group", projectRules("read-99", ["AGENTS.md"])],
	])("keeps %s as its own card", async (_, notice) => {
		const surface = await surfaceWith([notice], [0]);
		try {
			const text = surface.text();
			expect(text).toContain("Project rules · src/a.ts");
			expect(text).not.toContain("Applied");
		} finally {
			surface.cleanup();
		}
	});
});

describe.each(["compact", "grouped"] as const)("project rules in %s density", (density) => {
	async function denseSurface() {
		const surface = await explorationSurface(true, [registerRuleActivationRenderer]);
		if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
			surface.cleanup();
			throw new TypeError("Expected the interactive transcript");
		}
		surface.chat.setToolDisplayDensity(density);
		return { ...surface, chat: surface.chat };
	}

	function expand(surface: Awaited<ReturnType<typeof denseSurface>>, width: number) {
		const lines = surface.text(width).split("\n");
		const y = lines.findIndex((line) => line.includes("● project rules"));
		expect(y).toBeGreaterThanOrEqual(0);
		expect(
			surface.chat.handleMouse({
				type: "click",
				button: "left",
				x: 6,
				screenX: 6,
				y,
				screenY: y,
				width,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
			})?.handled,
		).toBe(true);
		return surface.text(width);
	}

	it("puts the listed rule in the title and the target in the expanded body", async () => {
		const surface = await denseSurface();
		try {
			const entry = projectRules(
				"read-notice",
				["skills/visual-qa/AGENTS.md"],
				"../../long/plugin/skills/visual-qa/SKILL.md",
			);
			await surface.event({ type: "entry_appended", entry });

			expect(surface.text()).toContain("● project rules • skills/visual-qa/AGENTS.md");
			expect(surface.text()).not.toContain(entry.data.targetPath);
			expect(expand(surface, 120)).toContain(`│ matched on: ${entry.data.targetPath}`);
			const narrow = surface.text(39);
			expect(narrow).toContain("● project rules • 1 rule matched");
			expect(narrow).toContain("├─ rule • skills/visual-qa/AGENTS.md");
		} finally {
			surface.cleanup();
		}
	});

	it("merges adjacent notices and preserves their rule-to-target associations at narrow widths", async () => {
		const surface = await denseSurface();
		try {
			for (const entry of [
				projectRules("first", ["AGENTS.md", "skills/AGENTS.md"], "plugin/skills/a.md"),
				projectRules("second", ["skills/visual  qa/AGENTS.md"], "plugin/skills/b  docs.md"),
			]) {
				await surface.event({ type: "entry_appended", entry });
			}

			expect(surface.text().match(/● project rules/g)).toHaveLength(1);
			expect(surface.text()).toContain("● project rules • AGENTS.md skills/AGENTS.md skills/visual  qa/AGENTS.md");
			expect(surface.text(45)).toContain("● project rules • 3 rules matched");
			expect(
				expand(surface, 45)
					.split("\n")
					.map((line) => line.trimEnd())
					.join("\n"),
			).toContain(
				" ├─ rule • AGENTS.md\n │ matched on: plugin/skills/a.md\n" +
					" ├─ rule • skills/AGENTS.md\n │ matched on: plugin/skills/a.md\n" +
					" ├─ rule • skills/visual  qa/AGENTS.md\n │ matched on: plugin/skills/b  docs.md",
			);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps one and two spaces distinct when rule and target paths wrap", async () => {
		const surface = await denseSurface();
		try {
			const rule = `rules/${"r".repeat(41)}`;
			const target = `src/${"t".repeat(39)}`;
			for (const spaces of [" ", "  "]) {
				await surface.event({
					type: "entry_appended",
					entry: projectRules(`wrap-${spaces.length}`, [`${rule}${spaces}rule.md`], `${target}${spaces}file.ts`),
				});
			}

			const expanded = expand(surface, 58)
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n");
			for (const spaces of [" ", "  "]) {
				expect
					.soft(expanded)
					.toContain(` ├─ rule • ${rule}\n ├─ ${spaces}rule.md\n │ matched on: ${target}\n │ ${spaces}file.ts`);
			}
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a stream-rule notice between separate project-rule cards", async () => {
		const surface = await denseSurface();
		try {
			await surface.event({ type: "entry_appended", entry: projectRules("first", ["AGENTS.md"]) });
			await surface.event({
				type: "entry_appended",
				entry: {
					...projectRules("stream", []),
					data: { kind: "ttsr", owner: "test owner", rules: ["stream rule"], remediation: "nudge" },
				},
			});
			await surface.event({ type: "entry_appended", entry: projectRules("second", ["src/AGENTS.md"]) });

			const titles = surface
				.text()
				.split("\n")
				.filter((line) => /project rules|Stream rule/i.test(line));
			expect(titles).toHaveLength(3);
			expect(titles[0]).toContain("project rules • AGENTS.md");
			expect(titles[1]).toMatch(/stream rule.*test owner/i);
			expect(titles[2]).toContain("project rules • src/AGENTS.md");
		} finally {
			surface.cleanup();
		}
	});
});
