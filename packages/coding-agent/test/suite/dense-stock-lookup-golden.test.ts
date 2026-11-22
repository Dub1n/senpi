import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createFindToolDefinition } from "../../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

type ProducedResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details: object | undefined;
	isError?: boolean;
};
type LookupProducer = {
	readonly name: "find" | "grep" | "ls";
	readonly args: ToolCall["arguments"];
	readonly execute: (cwd: string) => Promise<ProducedResult>;
};
type Density = "default" | "compact" | "grouped";

const width = 64;
const producers: readonly LookupProducer[] = [
	{
		name: "find",
		args: { pattern: "*.ts", path: "src" },
		execute: async (cwd) =>
			createFindToolDefinition(cwd, {
				operations: {
					exists: existsSync,
					glob: async (_pattern, searchPath) =>
						(await readdir(searchPath)).filter((entry) => entry.endsWith(".ts")),
				},
			}).execute("find", { pattern: "*.ts", path: "src" }, undefined, undefined, { cwd } as ExtensionToolContext),
	},
	{
		name: "grep",
		args: { pattern: "needle", path: "src/a.ts", context: 1 },
		execute: async (cwd) =>
			createGrepToolDefinition(cwd).execute(
				"grep",
				{ pattern: "needle", path: "src/a.ts", context: 1 },
				undefined,
				undefined,
				{ cwd } as ExtensionToolContext,
			),
	},
	{
		name: "ls",
		args: { path: "src" },
		execute: async (cwd) =>
			createLsToolDefinition(cwd).execute("ls", { path: "src" }, undefined, undefined, {
				cwd,
			} as ExtensionToolContext),
	},
];

function replayFor({ name, args }: LookupProducer, result: ProducedResult): readonly unknown[] {
	const id = `golden-${name}`;
	return [
		fauxAssistantMessage({ type: "toolCall", id, name, arguments: args }, { stopReason: "toolUse", timestamp: 0 }),
		{
			role: "toolResult",
			toolName: name,
			toolCallId: id,
			content: result.content,
			...(result.details === undefined ? {} : { details: result.details }),
			isError: result.isError ?? false,
			timestamp: 0,
		},
	];
}

async function visibleRows(
	surface: Awaited<ReturnType<typeof explorationSurface>>,
	density: Density,
	expanded: boolean,
): Promise<readonly string[]> {
	if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
		throw new TypeError("Expected the real exploration transcript");
	}
	surface.chat.setToolDisplayDensity(density);
	invoke(surface.mode, "setToolsExpanded", expanded);
	return surface.chat.render(width).map(stripTerminalSequences);
}

it.each(producers)("renders exact rows from the real $name producer", async (producer) => {
	const surface = await explorationSurface();
	try {
		const cwd = surface.harness.tempDir;
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(
			join(cwd, "src", "a.ts"),
			'export const needle = "needle";\nexport function locate() {\n  return needle;\n}\n',
		);
		await writeFile(join(cwd, "src", "b.ts"), "export const sibling = true;\n");
		const replay = replayFor(producer, await producer.execute(cwd));
		invoke(surface.mode, "renderSessionItems", replay);

		const folded = {
			find: ["", " ".repeat(width), " ╶─ ✓ find • *.ts · src".padEnd(width), " ".repeat(width)],
			grep: [
				"",
				" ".repeat(width),
				" ╶─ ✓ grep • /needle/ · src/a.ts · 1 file · 2 matches".padEnd(width),
				" ".repeat(width),
			],
			ls: ["", " ".repeat(width), " ╶─ ✓ ls • src · 2 entries".padEnd(width), " ".repeat(width)],
		} as const;
		const expanded = {
			find: [
				"",
				" ".repeat(width),
				" ╭─ ✓ find • *.ts · src".padEnd(width),
				" │ a.ts".padEnd(width),
				" │ b.ts".padEnd(width),
				" ╰─".padEnd(width),
				" ".repeat(width),
			],
			grep: [
				"",
				" ".repeat(width),
				" ╭─ ✓ grep • /needle/ · src/a.ts · 1 file · 2 matches".padEnd(width),
				" │ src/a.ts".padEnd(width),
				' │ 1: export const needle = "needle";'.padEnd(width),
				" │ 2- export function locate() {".padEnd(width),
				" │ 3:   return needle;".padEnd(width),
				" │ 4- }".padEnd(width),
				" ╰─".padEnd(width),
				" ".repeat(width),
			],
			ls: [
				"",
				" ".repeat(width),
				" ╭─ ✓ ls • src · 2 entries".padEnd(width),
				" │ a.ts".padEnd(width),
				" │ b.ts".padEnd(width),
				" ╰─".padEnd(width),
				" ".repeat(width),
			],
		} as const;
		const defaults = {
			find: [
				"",
				"• Explored",
				"",
				" ".repeat(width),
				" find *.ts in src".padEnd(width),
				" ".repeat(width),
				" a.ts".padEnd(width),
				" b.ts".padEnd(width),
				" ".repeat(width),
			],
			grep: [
				"",
				"• Explored",
				"",
				" ".repeat(width),
				" grep /needle/ in src/a.ts".padEnd(width),
				" ".repeat(width),
				" src/a.ts".padEnd(width),
				' 1: export const needle = "needle";'.padEnd(width),
				" 2- export function locate() {".padEnd(width),
				" 3:   return needle;".padEnd(width),
				" 4- }".padEnd(width),
				" ".repeat(width),
			],
			ls: [
				"",
				"• Explored",
				"",
				" ".repeat(width),
				" ls src".padEnd(width),
				" ".repeat(width),
				" a.ts".padEnd(width),
				" b.ts".padEnd(width),
				" ".repeat(width),
			],
		} as const;
		expect
			.soft(await visibleRows(surface, "compact", false), `${producer.name} folded`)
			.toEqual(folded[producer.name]);
		expect
			.soft(await visibleRows(surface, "grouped", true), `${producer.name} expanded`)
			.toEqual(expanded[producer.name]);
		if (producer.name === "grep") {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
				throw new TypeError("Expected the real exploration transcript");
			}
			const terminalRows = surface.chat.render(width);
			const plainRows = terminalRows.map(stripTerminalSequences);
			const matchRow = plainRows.findIndex((row) => row.includes("1: export const needle"));
			const contextRow = plainRows.findIndex((row) => row.includes("2- export function locate"));
			const terminal = new xterm.Terminal({
				cols: width + 1,
				rows: terminalRows.length,
				allowProposedApi: true,
			});
			try {
				await new Promise<void>((resolve) => terminal.write(terminalRows.join("\x1b[0m\r\n"), resolve));
				expect(terminal.buffer.active.getLine(matchRow)?.getCell(3)?.isDim()).toBe(0);
				expect(terminal.buffer.active.getLine(contextRow)?.getCell(3)?.isDim()).not.toBe(0);
			} finally {
				terminal.dispose();
			}
		}
		expect
			.soft(await visibleRows(surface, "default", true), `${producer.name} Default`)
			.toEqual(defaults[producer.name]);
	} finally {
		surface.cleanup();
	}
});
