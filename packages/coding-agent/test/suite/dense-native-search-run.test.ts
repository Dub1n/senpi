import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, dispatchMouseEvent, type TuiMouseEvent, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke, runTool } from "./exploration-surface-harness.ts";

const width = 120;
const densities = ["compact", "grouped"] as const;
type Density = (typeof densities)[number];

type SearchFixture = {
	readonly status: string;
	readonly query?: string;
	readonly sourceCount?: number;
};

function nativeSearch({ status, query, sourceCount = 0 }: SearchFixture) {
	return {
		type: "providerNative" as const,
		subtype: "web_search_call",
		raw: {
			status,
			...(query === undefined
				? {}
				: {
						action: {
							query,
							sources: Array.from({ length: sourceCount }, (_, index) => ({
								title: `result-${query}-${index + 1}`,
								url: `https://example.test/${query}/${index + 1}`,
							})),
						},
					}),
		},
	};
}

function searchMessage(...searches: readonly SearchFixture[]) {
	return {
		...fauxAssistantMessage(searches.map(nativeSearch), { timestamp: 0 }),
		provider: "chatgpt-subscription",
	};
}

async function denseSurface(density: Density) {
	const surface = await explorationSurface();
	if (!(surface.chat instanceof ExplorationTranscriptContainer)) {
		surface.cleanup();
		throw new TypeError("Expected the real exploration transcript");
	}
	surface.chat.setToolDisplayDensity(density);
	return { ...surface, chat: surface.chat };
}

function rendered(chat: Component, renderWidth = width): string[] {
	return chat.render(renderWidth).map(stripTerminalSequences);
}

function clickRow(chat: ExplorationTranscriptContainer, y: number, x = 6): void {
	const height = rendered(chat).length;
	const press: TuiMouseEvent = {
		type: "press",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	dispatchMouseEvent(chat, press);
	expect(dispatchMouseEvent(chat, { ...press, type: "click" })?.handled).toBe(true);
}

describe.each(densities)("dense native search runs in %s", (density) => {
	it("hides a completed status-only search without leaving transcript spacing", async () => {
		const surface = await denseSurface(density);
		try {
			invoke(surface.mode, "renderSessionItems", [searchMessage({ status: "completed" })]);
			expect(rendered(surface.chat)).toEqual([]);
		} finally {
			surface.cleanup();
		}
	});

	it.each([
		{ name: "zero-hit", status: "completed" },
		{ name: "pending", status: "in_progress" },
		{ name: "failed", status: "failed" },
	] as const)("retains a real $name query with no sources", async ({ status }) => {
		const surface = await denseSurface(density);
		try {
			invoke(surface.mode, "renderSessionItems", [
				searchMessage({ status, query: `${status}-query`, sourceCount: 0 }),
			]);
			invoke(surface.mode, "setToolsExpanded", true);
			const output = rendered(surface.chat).join("\n");
			expect(output).toContain(`search • "${status}-query"`);
			expect(output).toContain(`status: ${status}`);
		} finally {
			surface.cleanup();
		}
	});

	it("folds adjacent searches by per-search source counts and keeps each member clickable", async () => {
		const surface = await denseSurface(density);
		try {
			invoke(surface.mode, "renderSessionItems", [
				searchMessage(
					{ status: "completed", query: "first-private-query", sourceCount: 17 },
					{ status: "completed", query: "last-private-query", sourceCount: 3 },
				),
			]);
			let lines = rendered(surface.chat);
			let parent = lines.findIndex((line) => line.includes("search • 17 sources · 3 sources"));
			expect(parent).toBeGreaterThanOrEqual(0);
			expect(lines.join("\n")).not.toContain("first-private-query");
			expect(lines.join("\n")).not.toContain("last-private-query");
			clickRow(surface.chat, parent);

			lines = rendered(surface.chat);
			const lastMember = lines.findIndex(
				(line) => line.includes("3 sources") && line.includes("last-private-query"),
			);
			expect(lastMember).toBeGreaterThanOrEqual(0);
			expect(lines.join("\n")).toContain("first-private-query");
			expect(lines.join("\n")).toContain("result-first-private-query-17");
			expect(lines.join("\n")).toContain("result-last-private-query-3");
			clickRow(surface.chat, lastMember);
			expect(rendered(surface.chat).join("\n")).not.toContain("result-last-private-query-3");

			lines = rendered(surface.chat);
			const foldedLastMember = lines.findIndex(
				(line) => line.includes("3 sources") && line.includes("last-private-query"),
			);
			expect(foldedLastMember).toBeGreaterThanOrEqual(0);
			clickRow(surface.chat, foldedLastMember);
			expect(rendered(surface.chat).join("\n")).toContain("result-last-private-query-3");

			lines = rendered(surface.chat);
			const firstMember = lines.findIndex(
				(line) => line.includes("17 sources") && line.includes("first-private-query"),
			);
			expect(firstMember).toBeGreaterThanOrEqual(0);
			clickRow(surface.chat, firstMember, 1);
			lines = rendered(surface.chat);
			expect(lines.join("\n")).toContain("search • 17 sources · 3 sources");
			expect(lines.join("\n")).not.toContain("first-private-query");
			parent = lines.findIndex((line) => line.includes("search • 17 sources · 3 sources"));
			expect(parent).toBeGreaterThanOrEqual(0);
			clickRow(surface.chat, parent, 1);
			expect(rendered(surface.chat).join("\n")).toContain("result-last-private-query-3");
		} finally {
			surface.cleanup();
		}
	});

	it("ends native search runs at prose and real tool rows", async () => {
		const surface = await denseSurface(density);
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				searchMessage({ status: "completed", query: "first-query", sourceCount: 17 }),
			);
			invoke(surface.mode, "addMessageToChat", fauxAssistantMessage("A prose interruption."));
			invoke(
				surface.mode,
				"addMessageToChat",
				searchMessage({ status: "completed", query: "second-query", sourceCount: 3 }),
			);
			await runTool(surface, { id: "read-break", toolName: "read", args: { path: "break.ts" } });
			invoke(
				surface.mode,
				"addMessageToChat",
				searchMessage({ status: "completed", query: "third-query", sourceCount: 2 }),
			);

			const output = rendered(surface.chat).join("\n");
			expect(output).toContain("first-query");
			expect(output).toContain("second-query");
			expect(output).toContain("third-query");
			expect(output).toContain("A prose interruption.");
			expect(output).toContain("read • break.ts");
			expect(output).not.toContain("search • 17 sources · 3 sources");
			expect(output).not.toContain("search • 3 sources · 2 sources");
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a preceding read run before adjacent searches and following prose", async () => {
		const surface = await denseSurface(density);
		try {
			await runTool(surface, { id: "read-first", toolName: "read", args: { path: "first.ts" } });
			await runTool(surface, { id: "read-second", toolName: "read", args: { path: "second.ts" } });
			invoke(
				surface.mode,
				"addMessageToChat",
				searchMessage(
					{ status: "completed", query: "first-search", sourceCount: 17 },
					{ status: "completed", query: "second-search", sourceCount: 3 },
				),
			);
			invoke(surface.mode, "addMessageToChat", fauxAssistantMessage("After the searches."));

			const lines = rendered(surface.chat);
			const readRun = lines.findIndex((line) => line.includes("read • first.ts second.ts"));
			const searchRun = lines.findIndex((line) => line.includes("search • 17 sources · 3 sources"));
			const prose = lines.findIndex((line) => line.includes("After the searches."));
			expect(readRun).toBeGreaterThanOrEqual(0);
			expect(searchRun).toBeGreaterThan(readRun);
			expect(prose).toBeGreaterThan(searchRun);
		} finally {
			surface.cleanup();
		}
	});
});

it("preserves the native provider rendering in Default density", async () => {
	const surface = await explorationSurface();
	try {
		invoke(surface.mode, "renderSessionItems", [
			searchMessage({ status: "completed", query: "default-query", sourceCount: 1 }),
		]);
		const output = rendered(surface.chat).join("\n");
		expect(output).toContain("chatgpt-subscription · web_search · completed");
		expect(output).toContain('query: "default-query"');
		expect(output).toContain("result-default-query-1");
		expect(output).not.toContain("search •");
	} finally {
		surface.cleanup();
	}
});
