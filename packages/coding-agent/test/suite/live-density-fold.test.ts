import { stripTerminalSequences, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { toolCardNestingDefaults } from "../../src/core/settings-manager.ts";
import { createWriteDetails } from "../../src/core/tools/write-result.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

type Surface = Awaited<ReturnType<typeof explorationSurface>>;
const cases = [
	{ density: "compact", width: 64, colorFrames: false },
	{ density: "grouped", width: 120, colorFrames: true },
] as const;

function denseChat(surface: Surface, { density, colorFrames }: (typeof cases)[number]) {
	if (!(surface.chat instanceof ExplorationTranscriptContainer))
		throw new TypeError("Expected exploration transcript");
	surface.chat.setToolDisplayDensity(density);
	surface.chat.setToolDisplayColors({ colorFrames, colorNames: false, colorIcons: false });
	return surface.chat;
}

function shell(id: string) {
	return { toolCallId: id, toolName: "bash", args: { command: `echo ${id}` } };
}

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function mouse(
	surface: Surface,
	target: { readonly tool: string; readonly width: number; readonly type?: TuiMouseEvent["type"] },
) {
	const lines = surface.chat.render(target.width).map(stripTerminalSequences);
	const row = lines.findIndex((line) => /^[ ]+[╶╭├╰]─/u.test(line) && line.includes(target.tool));
	expect(lines[row]).toContain(target.tool);
	return surface.chat.handleMouse({
		type: target.type ?? "click",
		button: "left",
		x: 6,
		y: row,
		screenX: 6,
		screenY: row,
		width: target.width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe.each(cases)("$density live tool folds at $width columns", (config) => {
	const { width } = config;
	it("folds both workers independently inside a Task batch", async () => {
		const surface = await explorationSurface();
		try {
			const chat = denseChat(surface, config);
			chat.setDenseCardPreferences({ task: "unfolded" }, toolCardNestingDefaults);
			const call = {
				toolName: "task",
				toolCallId: "batch-live",
				args: { tasks: [{ prompt: "first worker body" }, { prompt: "second worker body" }] },
			};
			await surface.event({ type: "tool_execution_start", ...call });
			await surface.event({
				type: "tool_execution_end",
				...call,
				isError: false,
				result: textResult("spawned two workers", {
					mode: "spawn",
					task_id: "st_first",
					status: "running",
					items: [
						{ task_id: "st_first", nickname: "FirstWorker", status: "running" },
						{ task_id: "st_second", nickname: "SecondWorker", status: "running" },
					],
				}),
			});
			expect(surface.text(width)).toMatch(/first worker body[\s\S]+second worker body/u);
			expect(mouse(surface, { tool: "FirstWorker", width })?.handled).toBe(true);
			expect(surface.text(width)).not.toContain("first worker body");
			expect(surface.text(width)).toContain("second worker body");
			expect(mouse(surface, { tool: "SecondWorker", width })?.handled).toBe(true);
			expect(surface.text(width)).not.toContain("second worker body");
			expect(mouse(surface, { tool: "FirstWorker", width })?.handled).toBe(true);
			expect(surface.text(width)).toContain("first worker body");
			expect(surface.text(width)).not.toContain("second worker body");
		} finally {
			surface.cleanup();
		}
	});

	it.each([false, true])(
		"uses the settled write name unless the running card was manually opened (%s)",
		async (manual) => {
			const surface = await explorationSurface();
			try {
				const chat = denseChat(surface, config);
				chat.setDenseCardPreferences(
					{ write: "folded", edited: "unfolded", added: "folded" },
					toolCardNestingDefaults,
				);
				const call = {
					toolName: "write",
					toolCallId: "write-live",
					args: { path: "example.txt", content: "new\n" },
				};
				await surface.event({ type: "tool_execution_start", ...call });
				expect(surface.text(width)).toMatch(/╶─.*write.*example\.txt/u);
				if (manual) expect(mouse(surface, { tool: "write", width })?.handled).toBe(true);

				chat.setDenseCardPreferences(
					{ write: "unfolded", edited: "unfolded", added: "folded" },
					toolCardNestingDefaults,
				);
				await surface.event({
					type: "tool_execution_end",
					...call,
					isError: false,
					result: textResult(
						"wrote file",
						createWriteDetails(call.args.path, call.args.content, { kind: "missing" }),
					),
				});
				expect(surface.text(width)).toMatch(new RegExp(`${manual ? "╭─" : "╶─"}.*added.*example\\.txt`, "u"));
			} finally {
				surface.cleanup();
			}
		},
	);
	it("applies new defaults to future cards without snapping existing cards or changing Default", async () => {
		const surface = await explorationSurface();
		try {
			const chat = denseChat(surface, config);
			chat.setDenseCardPreferences({ tool: "unfolded" }, toolCardNestingDefaults);
			const call = (id: string) => ({ toolName: "unregistered", toolCallId: id, args: {} });
			await surface.event({ type: "tool_execution_start", ...call("before") });
			await surface.event({
				type: "tool_execution_update",
				...call("before"),
				partialResult: textResult("keep-before"),
			});
			expect(surface.text(width)).toContain("keep-before");
			chat.setDenseCardPreferences({ tool: "folded" }, toolCardNestingDefaults);
			await surface.event({ type: "tool_execution_start", ...call("after") });
			await surface.event({
				type: "tool_execution_update",
				...call("after"),
				partialResult: textResult("hide-after"),
			});
			const dense = surface.text(width);
			expect(dense).toContain("keep-before");
			expect(dense).not.toContain("hide-after");
			for (const id of ["before", "after"]) {
				await surface.event({
					type: "tool_execution_end",
					...call(id),
					result: textResult(`final-${id}`),
					isError: false,
				});
			}
			expect(surface.text(width)).toContain("final-before");
			expect(surface.text(width)).not.toContain("final-after");
			chat.setToolDisplayDensity("default");
			const normal = surface.text(width);
			expect(normal).not.toMatch(/╶─|╭─/u);
			expect(normal).toContain("final-before");
			expect(normal).toContain("final-after");
		} finally {
			surface.cleanup();
		}
	});
	it("opens a silent running card without opening a simultaneous invocation", async () => {
		const surface = await explorationSurface();
		const terminal = new VirtualTerminal(width, 40);
		const tui = new TuiAltScreen(terminal);
		try {
			const chat = denseChat(surface, config);
			tui.addChild(chat);
			Reflect.set(surface.mode, "ui", tui);
			for (const toolCallId of ["live-a", "live-b"]) {
				await surface.event({ type: "tool_execution_start", ...shell(toolCallId) });
			}
			tui.start();
			tui.renderNow();
			const before = await terminal.flushAndGetViewport();
			const parentRow = before.findIndex((line) => line.includes("╶─ ~ bash")) + 1;
			expect(before[parentRow - 1]).toMatch(/╶─ ~ bash/u);
			terminal.sendInput(`\x1b[<0;6;${parentRow}M`);
			terminal.sendInput(`\x1b[<32;15;${parentRow}M`);
			terminal.sendInput(`\x1b[<0;15;${parentRow}m`);
			tui.renderNow();
			expect((await terminal.flushAndGetViewport()).join("\n")).toMatch(/╶─ ~ bash/u);

			terminal.sendInput(`\x1b[<0;6;${parentRow}M`);
			terminal.sendInput(`\x1b[<0;6;${parentRow}m`);
			tui.renderNow();
			const opened = await terminal.flushAndGetViewport();
			const secondMemberRow = opened.findIndex((line) => line.includes("echo live-b")) + 1;
			expect(opened[secondMemberRow - 1]).toMatch(/├─ ○ bash • echo live-b/u);
			await surface.event({
				type: "tool_execution_update",
				...shell("live-a"),
				partialResult: textResult("output live-a"),
			});
			await surface.event({
				type: "tool_execution_update",
				...shell("live-b"),
				partialResult: textResult("output live-b"),
			});
			expect(mouse(surface, { tool: "live-b", width })?.handled).toBe(true);
			tui.renderNow();
			const after = (await terminal.flushAndGetViewport()).join("\n");
			expect(after).toContain("output live-a");
			expect(after).not.toContain("output live-b");
		} finally {
			tui.detachAll();
			tui.stop();
			surface.cleanup();
		}
	});

	it("does not toggle a replacement invocation under a fullscreen release", async () => {
		const surface = await explorationSurface();
		const terminal = new VirtualTerminal(width, 40);
		const tui = new TuiAltScreen(terminal);
		try {
			const chat = denseChat(surface, config);
			tui.addChild(chat);
			Reflect.set(surface.mode, "ui", tui);
			await surface.event({ type: "tool_execution_start", ...shell("anchor") });
			const call = shell("going-away");
			await surface.event({ type: "tool_execution_start", ...call });
			await surface.event({ type: "tool_execution_start", ...shell("replacement") });
			tui.start();
			tui.renderNow();
			const before = await terminal.flushAndGetViewport();
			const parentRow = before.findIndex((line) => line.includes("╶─ ~ bash")) + 1;
			expect(before[parentRow - 1]).toMatch(/╶─ ~ bash/u);
			terminal.sendInput(`\x1b[<0;6;${parentRow}M`);
			terminal.sendInput(`\x1b[<0;6;${parentRow}m`);
			tui.renderNow();
			const opened = await terminal.flushAndGetViewport();
			const row = opened.findIndex((line) => line.includes("echo going-away")) + 1;
			expect(opened[row - 1]).toMatch(/├─ ○ bash • echo going-away/u);
			terminal.sendInput(`\x1b[<0;6;${row}M`);

			await surface.event({
				type: "tool_execution_end",
				...call,
				result: textResult("finished"),
				isError: false,
			});
			const outgoing = chat.children.find(
				(child) => child instanceof ToolExecutionComponent && child.toolCallId === call.toolCallId,
			);
			if (!(outgoing instanceof ToolExecutionComponent)) throw new TypeError("Expected the outgoing invocation");
			chat.removeChild(outgoing);
			tui.renderNow();
			expect((await terminal.flushAndGetViewport())[row - 1]).toMatch(/├─ ○ bash • echo replacement/u);
			terminal.sendInput(`\x1b[<0;6;${row}m`);
			tui.renderNow();
			expect((await terminal.flushAndGetViewport())[row - 1]).toMatch(/├─ ○ bash • echo replacement/u);
		} finally {
			tui.detachAll();
			tui.stop();
			surface.cleanup();
		}
	});

	it("reveals the latest partial immediately, trims the preview, and never replaces the final with late output", async () => {
		const surface = await explorationSurface();
		vi.useFakeTimers();
		try {
			const chat = denseChat(surface, config);
			surface.harness.session.settingsManager.setSmoothStreaming(true);
			const call = shell("streaming-preview");
			await surface.event({ type: "tool_execution_start", ...call });
			const update = (text: string, activity = "compiling modules") =>
				surface.event({
					type: "tool_execution_update",
					...call,
					partialResult: textResult(text, { progress: { activity, startedAt: Date.now() } }),
				});
			const lines = Array.from({ length: 16 }, (_, i) => `partial-${i} ${"word ".repeat(28).trimEnd()}`);
			const target = lines.join("\n") + "\n  latest";
			await update("partial");
			await update(target);
			expect(surface.text(width)).not.toContain("latest");

			expect(mouse(surface, { tool: call.toolCallId, width })?.handled).toBe(true);
			const preview = chat.render(width).map(stripTerminalSequences);
			expect(preview.filter((line) => line.startsWith(" ╭─"))).toHaveLength(1);
			expect(preview.filter((line) => line.startsWith(" ╰─"))).toHaveLength(1);
			expect(preview.filter((line) => line.includes("latest"))).toEqual([
				expect.stringMatching(/^ │ {3}latest\s*$/u),
			]);
			expect(preview.some((line) => line.includes("compiling modules"))).toBe(true);
			expect(preview.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(preview.join("\n")).not.toContain("partial-0");

			await update(target, "linking modules");
			expect(surface.text(width)).toContain("linking modules");
			await update(`${target}\nqueued-while-open`);
			await surface.event({
				type: "tool_execution_end",
				...call,
				result: textResult("final-output"),
				isError: false,
			});
			await update("late-partial");
			await vi.advanceTimersByTimeAsync(1000);
			chat.setToolDisplayDensity(config.density === "compact" ? "grouped" : "compact");
			chat.invalidate();
			const final = surface.text(width === 64 ? 120 : 64);
			expect(final).toMatch(/╭─[^\n]*streaming-preview/u);
			expect(final.match(/final-output/gu)).toHaveLength(1);
			expect(final).not.toMatch(/latest|queued-while-open|late-partial/u);
		} finally {
			await surface.event({ type: "agent_end", messages: [], willRetry: false });
			vi.useRealTimers();
			surface.cleanup();
		}
	});

	it.each([
		{ name: "error", result: "command failed", refold: false },
		{ name: "cancellation", result: "Operation aborted", refold: true },
	])("retains the explicit live choice on $name", async ({ name, result, refold }) => {
		const surface = await explorationSurface();
		const tool = `unregistered-${name}`;
		const call = { toolCallId: `custom-${name}`, toolName: tool, args: {} };
		try {
			denseChat(surface, config);
			await surface.event({ type: "tool_execution_start", ...call });
			const partial: AgentSessionEvent = {
				type: "tool_execution_update",
				...call,
				partialResult: textResult("plain fallback\n  indented preview"),
			};
			await surface.event(partial);
			expect(mouse(surface, { tool, width })?.handled).toBe(true);
			expect(surface.text(width)).toMatch(/^ │ {3}indented preview\s*$/mu);
			if (refold) expect(mouse(surface, { tool, width })?.handled).toBe(true);
			await surface.event({ type: "tool_execution_end", ...call, result: textResult(result), isError: true });
			const settled = surface.text(width);
			expect(settled).toMatch(new RegExp(`${refold ? "╶─" : "╭─"}[^\\n]*${tool}`, "u"));
			expect(settled.includes(result)).toBe(!refold);
			expect(settled).not.toContain("indented preview");
			if (refold) {
				expect(mouse(surface, { tool, width })?.handled).toBe(true);
				expect(surface.text(width)).toContain(result);
			}
			invoke(surface.mode, "setToolsExpanded", true);
			invoke(surface.mode, "setToolsExpanded", false);
			expect(surface.text(width)).toMatch(new RegExp(`╶─[^\\n]*${tool}`, "u"));
		} finally {
			surface.cleanup();
		}
	});
});
