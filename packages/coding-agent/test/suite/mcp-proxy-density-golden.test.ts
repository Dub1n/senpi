import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createMcpProxyTool } from "../../src/core/extensions/builtin/mcp/expose/proxy.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const gateway = createMcpProxyTool("fx", []);

async function rows(
	density: "compact" | "grouped" | "default",
	expanded: boolean,
	args: { op: "search" | "describe" | "call"; query?: string; tool?: string },
	payload: string,
	isError = false,
	width = 48,
) {
	const surface = await explorationSurface(true, [(pi) => pi.registerTool(gateway)]);
	try {
		if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
		const result: ToolResultMessage = {
			role: "toolResult",
			toolName: "mcp_fx",
			toolCallId: "proxy",
			timestamp: 0,
			isError,
			content: [{ type: "text", text: payload }],
			details: { server: "fx", tool: "proxy", preview: payload.split("\n")[0] },
		};
		invoke(surface.mode, "renderSessionItems", [
			fauxAssistantMessage(
				{ type: "toolCall", id: "proxy", name: "mcp_fx", arguments: args },
				{ stopReason: "toolUse", timestamp: 0 },
			),
			result,
		]);
		surface.chat.setToolDisplayDensity(density);
		invoke(surface.mode, "setToolsExpanded", expanded);
		return surface.chat.render(width).map(stripTerminalSequences);
	} finally {
		surface.cleanup();
	}
}

function card(width: number, ...body: string[]) {
	return ["", ...["", ...body, ""].map((row) => row.padEnd(width))];
}

describe.each(["compact", "grouped"] as const)("%s proxy management", (density) => {
	it("shows search results without inventing a count", async () => {
		const args = { op: "search", query: "find files" } as const;
		const payload = "Tools on 'fx':\n- find - Find files";
		expect(await rows(density, false, args, payload)).toEqual(card(48, ' ╶─ ◉ tool "find files"'));
		expect(await rows(density, true, args, payload)).toEqual(
			card(48, ' ╭─ ◉ tool "find files"', " │ server: fx", " │ Tools on 'fx':", " │ - find - Find files", " ╰─"),
		);
	});

	it("preserves describe schema indentation and unknown guidance", async () => {
		const args = { op: "describe", tool: "find" } as const;
		expect(
			await rows(density, true, args, 'find: Find files\nInput schema (JSON Schema):\n{\n  "type": "object"\n}'),
		).toEqual(
			card(
				48,
				" ╭─ ◉ tool describe find",
				" │ server: fx",
				" │ find: Find files",
				" │ Input schema (JSON Schema):",
				" │ {",
				' │   "type": "object"',
				" │ }",
				" ╰─",
			),
		);
		expect(await rows(density, true, args, "Unknown tool 'find' on 'fx'.")).toEqual(
			card(48, " ╭─ ✗ tool describe find", " │ server: fx", " │ Unknown tool 'find' on 'fx'.", " ╰─"),
		);
	});

	it("shows explicitly failed management results", async () => {
		expect(await rows(density, true, { op: "search", query: "x" }, "transport failed", true)).toEqual(
			card(48, ' ╭─ ✗ tool "x"', " │ server: fx", " │ transport failed", " ╰─"),
		);
	});

	it("truncates long queries at narrow widths", async () => {
		expect(
			await rows(density, false, { op: "search", query: "a very long query for files" }, "result", false, 24),
		).toEqual(card(24, ' ╶─ ◉ tool "a very lo…'));
	});

	it("leaves ordinary calls on the existing fallback", async () => {
		expect(await rows(density, true, { op: "call", tool: "find" }, "called")).toEqual(
			card(48, " ╭─ mcp_fx call find", " │  mcp_fx: called", " ╰─"),
		);
	});
});

it("keeps default proxy rendering unchanged", async () => {
	expect(await rows("default", true, { op: "search", query: "x" }, "Tools on 'fx':\n- find")).toEqual([
		"",
		...["", " mcp_fx search x", " mcp_fx: Tools on 'fx':", ""].map((row) => row.padEnd(48)),
	]);
});
