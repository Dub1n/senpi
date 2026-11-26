// senpi#6201: a background terminal session that is still running reports its age (first at 10 minutes, then every
// 30 minutes) to the agent, the TUI and RPC drivers, naming the session and how to stop it. Nothing is killed unless
// auto-reap was opted into, and a reaped session says so. The clock is vitest's fake one; nothing sleeps.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TERMINAL_BACKGROUND_AGE_EVENT,
	type TerminalBackgroundAgeEvent,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import {
	bundleSinks,
	type TerminalExtensionState,
} from "../../src/core/extensions/builtin/terminal/extension-state.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { TerminalNotifier, type TerminalNotifierDeps } from "../../src/core/extensions/builtin/terminal/notify.ts";
import {
	type TerminalEventSinks,
	TerminalSessionBundle,
} from "../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalExitView } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createCustomMessage } from "../../src/core/messages.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const denseLayouts = ["compact", "grouped"] as const;

function recordingSinks(): { sinks: TerminalEventSinks; ages: TerminalBackgroundAgeEvent[] } {
	const ages: TerminalBackgroundAgeEvent[] = [];
	return {
		ages,
		sinks: {
			onMonitorEvent: () => {},
			onMonitorState: () => {},
			onMonitorEnded: () => {},
			onBackgroundState: () => {},
			onBackgroundExit: () => {},
			onBackgroundAge: (event) => ages.push(event),
		},
	};
}

function exitView(extra: Partial<TerminalExitView> = {}): TerminalExitView {
	return {
		exitResult: { exitCode: null, signal: "SIGTERM", cancelled: true, timedOut: false },
		fullOutput: () => "last line",
		...extra,
	};
}

let bundles: TerminalSessionBundle[] = [];
function bundle(): TerminalSessionBundle {
	const created = new TerminalSessionBundle({});
	bundles.push(created);
	return created;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(async () => {
	for (const created of bundles) await created.teardown();
	bundles = [];
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("background session age events", () => {
	it("reports nothing before 10 minutes, then at 10, 40 and 70 minutes, naming the session and its stop call", () => {
		const { sinks, ages } = recordingSinks();
		const terminal = bundle();
		terminal.bind(sinks);
		terminal.notifyBackgroundStart("bash_1", "dev server", Date.now(), { command: "npm run dev" });

		vi.advanceTimersByTime(10 * MINUTE - 1);
		expect(ages).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(ages).toEqual([
			{
				kind: "running",
				id: "bash_1",
				description: "dev server",
				command: "npm run dev",
				startedAtMs: T0,
				ageMs: 10 * MINUTE,
				ageMinutes: 10,
				autoReapMinutes: null,
				stop: { tool: "kill_bash", args: { bash_id: "bash_1" } },
			},
		]);

		vi.advanceTimersByTime(30 * MINUTE - 1);
		expect(ages).toHaveLength(1);
		vi.advanceTimersByTime(1);
		vi.advanceTimersByTime(30 * MINUTE);
		expect(ages.map((event) => event.ageMinutes)).toEqual([10, 40, 70]);
	});

	it("stops reporting once the session exits and leaves no timer behind", () => {
		const { sinks, ages } = recordingSinks();
		const terminal = bundle();
		terminal.bind(sinks);
		const baseline = vi.getTimerCount();
		terminal.notifyBackgroundStart("bash_1", "build", Date.now());
		expect(vi.getTimerCount()).toBe(baseline + 1);

		vi.advanceTimersByTime(9 * MINUTE);
		terminal.notifyBackgroundExit(
			"bash_1",
			exitView({ exitResult: { exitCode: 0, signal: null, cancelled: false, timedOut: false } }),
		);
		expect(vi.getTimerCount()).toBe(baseline);
		vi.advanceTimersByTime(5 * 60 * MINUTE);
		expect(ages).toEqual([]);
	});

	it("arms one timer for many sessions and clears it on teardown", async () => {
		const { sinks, ages } = recordingSinks();
		const terminal = bundle();
		terminal.bind(sinks);
		const baseline = vi.getTimerCount();
		terminal.notifyBackgroundStart("bash_1", "a", Date.now());
		vi.advanceTimersByTime(3 * MINUTE);
		terminal.notifyBackgroundStart("bash_2", "b", Date.now());
		expect(vi.getTimerCount()).toBe(baseline + 1);

		vi.advanceTimersByTime(10 * MINUTE);
		expect(ages.map((event) => [event.id, event.ageMinutes])).toEqual([
			["bash_1", 10],
			["bash_2", 10],
		]);
		await terminal.teardown();
		expect(vi.getTimerCount()).toBe(baseline);
	});

	it("reports one event, not a burst, when the clock jumps past several milestones (sleep, or a re-registered old session)", () => {
		const { sinks, ages } = recordingSinks();
		const terminal = bundle();
		terminal.bind(sinks);
		terminal.notifyBackgroundStart("bash_1", "long job", Date.now());
		// The machine sleeps: wall time moves 85 minutes while no timer runs.
		vi.setSystemTime(T0 + 85 * MINUTE);
		vi.advanceTimersToNextTimer();
		expect(ages.map((event) => event.ageMinutes)).toEqual([95]);
		vi.advanceTimersByTime(5 * MINUTE);
		expect(ages.map((event) => event.ageMinutes)).toEqual([95, 100]);

		// A session registered long after it started gets no catch-up event for the milestones it already passed.
		terminal.notifyBackgroundStart("bash_2", "restored", Date.now() - 75 * MINUTE);
		vi.advanceTimersByTime(25 * MINUTE - 1);
		expect(ages.filter((event) => event.id === "bash_2")).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(ages.filter((event) => event.id === "bash_2").map((event) => event.ageMinutes)).toEqual([100]);
	});

	it("while parked keeps only the newest event per session and drops it when the session exits", () => {
		const { sinks, ages } = recordingSinks();
		const terminal = bundle();
		terminal.bind(sinks);
		terminal.notifyBackgroundStart("bash_1", "kept", Date.now());
		terminal.notifyBackgroundStart("bash_2", "exits", Date.now());
		terminal.park();
		vi.advanceTimersByTime(45 * MINUTE);
		terminal.notifyBackgroundExit("bash_2", exitView());
		expect(ages).toEqual([]);

		terminal.bind(sinks);
		expect(ages.map((event) => [event.id, event.ageMinutes])).toEqual([["bash_1", 40]]);
	});
});

describe("background age delivery through the extension sinks", () => {
	function harness(ui?: ExtensionUIContext) {
		const emitted: Array<{ via: "events" | "rpc"; name: string; data: unknown }> = [];
		const messages: Array<Parameters<TerminalNotifierDeps["sendMessage"]>[0] & { options: unknown }> = [];
		const notices: Array<{ text: string; level: string }> = [];
		const pi = {
			events: { emit: (name: string, data: unknown) => emitted.push({ via: "events", name, data }) },
			rpc: { emit: (name: string, data: unknown) => emitted.push({ via: "rpc", name, data }) },
			isLoopRemote: () => false,
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			model: { provider: "faux", id: "faux" },
			ui: ui ?? { notify: (text: string, level: string) => notices.push({ text, level }) },
		} as unknown as ExtensionContext;
		const state = {
			ctx,
			parked: false,
			manifestWriter: null,
			ensurePersistence: null,
			recordedBackgroundIds: new Set<string>(),
			statusTicker: { sync: () => {}, stop: () => {} },
			notifier: new TerminalNotifier({
				sendMessage: (message, options) => messages.push({ ...message, options }),
				getContext: () => ctx,
				getMode: () => "wake",
			}),
		} as unknown as TerminalExtensionState;
		const terminal = bundle();
		const sinks = bundleSinks(pi, state);
		terminal.bind(sinks);
		const ageEvents = () =>
			emitted.filter((entry) => entry.name === TERMINAL_BACKGROUND_AGE_EVENT).map((entry) => entry.via);
		return { terminal, emitted, messages, notices, ageEvents, sinks };
	}

	it.each(denseLayouts)("frames live and rebound bash age notices in %s", async (density) => {
		const output = createBashOutputTool({
			cwd: process.cwd(),
			defaultCols: 80,
			defaultRows: 24,
			getEnv: () => ({}),
			manager: new TerminalManager(),
		});
		const surface = await explorationSurface(true, [
			{ name: "density-bash-poll", factory: (pi) => pi.registerTool(output) },
		]);
		try {
			Reflect.deleteProperty(surface.mode, "showStatus");
			const { chat, mode } = surface;
			if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected density transcript");
			const ui = invoke(mode, "createExtensionUIContext") as ExtensionUIContext;
			const runner = surface.harness.getExtensionRunner();
			runner.setUIContext(ui, "tui");
			const { terminal, messages, sinks } = harness(runner.getUIContext());
			const now = Date.now();
			terminal.notifyBackgroundStart("bash_38", "long job", now, { command: "printf first\nprintf second" });
			vi.advanceTimersByTime(10 * MINUTE);
			expect(surface.text()).toContain("printf second) has been running for 10 minutes.");
			expect(surface.text()).not.toContain("! bash");
			chat.clear();
			chat.setToolDisplayDensity(density);
			const stdout = "Background terminal session bash_99 (not a notice) has been running for 40 minutes.";
			const polls = [
				{ sessionId: "bash_36", processStatus: "completed", exitCode: 0, body: stdout },
				{ sessionId: "bash_37", processStatus: "exited_3", exitCode: 3, body: "failed output" },
			];
			invoke(mode, "renderSessionItems", [
				fauxAssistantMessage(
					polls.map(({ sessionId }) => fauxToolCall("bash_output", { bash_id: sessionId }, { id: sessionId })),
					{ stopReason: "toolUse", timestamp: 0 },
				),
				...polls.map(({ sessionId, processStatus, exitCode, body }) => {
					const header = `status: ${processStatus}`;
					return {
						role: "toolResult",
						toolName: "bash_output",
						toolCallId: sessionId,
						content: [{ type: "text", text: `${header}\n${body}` }],
						details: {
							bashOutput: {
								sessionId,
								processStatus,
								exitCode,
								statusStart: 0,
								statusEnd: header.length,
								view: "log",
								poll: { body, bodyFingerprint: body, notices: {} },
							},
						},
						isError: false,
						timestamp: 0,
					};
				}),
			]);
			expect(surface.text()).toContain("╶─ ~ bash 36 37");
			terminal.park();
			vi.advanceTimersByTime(30 * MINUTE);
			terminal.bind(sinks);
			expect(surface.text()).toContain("╶─ ! bash 36 37 38");
			expect(surface.text()).not.toContain("╶─ ~ bash");
			terminal.notifyBackgroundReapFailed("bash_38", 40, "cannot stop");
			terminal.notifyBackgroundReapFailed("bash_38", 40, "cannot stop");
			terminal.notifyBackgroundExit("bash_38", exitView({ autoReapedAfterMinutes: 40 }));

			expect(messages.map(({ display }) => display)).toEqual([false, false, false, false, false]);
			invoke(mode, "setToolsExpanded", true);
			const rendered = surface.text();
			expect(rendered).toContain("╭─ ✓ bash 36 • completed");
			expect(rendered).toContain("├─ × bash 37 • exit code 3");
			expect(rendered).toContain("├─ ! bash 38 • running for 40 minutes");
			expect(rendered.match(/├─ ! bash 38 • auto-reap failed/gu)).toHaveLength(1);
			expect(rendered).toContain("├─ ! bash 38 • auto-reaped");
			expect(rendered).toContain("│ printf second) has been running for 40 minutes.");
			expect(rendered).toContain(`│ ${stdout}`);
			expect(rendered).not.toContain("! bash 99");

			chat.clear();
			invoke(
				mode,
				"renderSessionItems",
				messages.map(({ customType, content, display, details }) =>
					createCustomMessage(customType, content, display, details, new Date().toISOString()),
				),
			);
			expect(surface.text()).toBe("");
		} finally {
			surface.cleanup();
		}
	});

	it.each(denseLayouts)("coalesces consecutive %s running notices when switched to Default", async (density) => {
		const surface = await explorationSurface();
		try {
			const { chat, mode } = surface;
			if (!(chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected density transcript");
			// Expand before delivery so the expansion feedback cannot add a separate status row.
			invoke(mode, "setToolsExpanded", true);
			Reflect.deleteProperty(mode, "showStatus");
			const ui = invoke(mode, "createExtensionUIContext") as ExtensionUIContext;
			const { terminal, messages } = harness(ui);
			chat.setToolDisplayDensity(density);
			terminal.notifyBackgroundStart("bash_38", "long job");
			vi.advanceTimersByTime(40 * MINUTE);
			expect(surface.text()).toContain("! bash 38 • running for 10 minutes");
			expect(surface.text()).toContain("! bash 38 • running for 40 minutes");

			chat.setToolDisplayDensity("default");
			const switched = surface.text();
			expect(switched).toContain("has been running for 40 minutes");
			expect(switched).not.toContain("has been running for 10 minutes");

			chat.setToolDisplayDensity(density);
			expect(surface.text()).toContain("! bash 38 • running for 10 minutes");

			chat.clear();
			chat.setToolDisplayDensity("default");
			for (const { content } of messages) {
				ui.notify(content.replace(/^<system-reminder>|<\/system-reminder>$/gu, ""), "info");
			}
			expect(switched).toBe(surface.text());

			terminal.notifyBackgroundExit("bash_38", exitView());
			chat.clear();
			chat.setToolDisplayDensity(density);
			terminal.notifyBackgroundStart("bash_39", "another long job");
			vi.advanceTimersByTime(10 * MINUTE);
			expect(surface.text()).toContain("! bash 39 • running for 10 minutes");
			chat.setToolDisplayDensity("default");
			vi.advanceTimersByTime(30 * MINUTE);
			expect(surface.text()).toContain("has been running for 40 minutes");
			expect(surface.text()).not.toContain("has been running for 10 minutes");
			ui.notify("Ordinary status after terminal notice", "info");
			expect(surface.text()).toContain("Ordinary status after terminal notice");
			expect(surface.text()).not.toContain("has been running for 40 minutes");
			vi.advanceTimersByTime(30 * MINUTE);
			expect(surface.text()).toContain("has been running for 70 minutes");
			expect(surface.text()).not.toContain("Ordinary status after terminal notice");
		} finally {
			surface.cleanup();
		}
	});

	it("tells the agent, the TUI and RPC drivers that a session is still running and how to stop it", () => {
		const { terminal, emitted, messages, notices, ageEvents } = harness();
		terminal.notifyBackgroundStart("bash_7", "tail logs", Date.now(), { command: "tail -f app.log" });
		vi.advanceTimersByTime(10 * MINUTE);

		expect(ageEvents()).toEqual(["events", "rpc"]);
		const rpc = emitted.find((entry) => entry.via === "rpc" && entry.name === TERMINAL_BACKGROUND_AGE_EVENT);
		expect(rpc?.data).toMatchObject({ kind: "running", id: "bash_7", ageMinutes: 10, command: "tail -f app.log" });
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toContain("bash_7");
		expect(messages[0]?.content).toContain("tail -f app.log");
		expect(messages[0]?.content).toContain("10 minutes");
		expect(messages[0]?.content).toContain('kill_bash({ bash_id: "bash_7" })');
		expect(messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(notices).toHaveLength(1);
		expect(notices[0]?.text).toContain("bash_7");
	});

	it("says a session was stopped by auto-reap, in the completion notice and as a typed event", () => {
		const { terminal, emitted, messages, notices, ageEvents } = harness();
		terminal.notifyBackgroundStart("bash_8", "soak", Date.now(), { command: "./soak.sh", autoReapMinutes: 60 });
		vi.advanceTimersByTime(60 * MINUTE);
		messages.length = 0;
		notices.length = 0;
		emitted.length = 0;
		terminal.notifyBackgroundExit("bash_8", exitView({ autoReapedAfterMinutes: 60 }));

		expect(ageEvents()).toEqual(["events", "rpc"]);
		const rpc = emitted.find((entry) => entry.via === "rpc" && entry.name === TERMINAL_BACKGROUND_AGE_EVENT);
		expect(rpc?.data).toMatchObject({ kind: "reaped", id: "bash_8", autoReapMinutes: 60, ageMinutes: 60 });
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toContain("bash_8");
		expect(messages[0]?.content).toContain("stopped automatically after 60 minutes");
		expect(notices.map((notice) => notice.level)).toEqual(["warning"]);
	});

	it("says once that auto-reap failed and why, and the session keeps reporting its age", () => {
		const { terminal, emitted, messages, notices, ageEvents } = harness();
		terminal.notifyBackgroundStart("bash_9", "soak", Date.now(), { command: "./soak.sh", autoReapMinutes: 60 });
		vi.advanceTimersByTime(60 * MINUTE);
		messages.length = 0;
		notices.length = 0;
		emitted.length = 0;
		terminal.notifyBackgroundReapFailed("bash_9", 60, "EPERM: operation not permitted");

		expect(ageEvents()).toEqual(["events", "rpc"]);
		const rpc = emitted.find((entry) => entry.via === "rpc" && entry.name === TERMINAL_BACKGROUND_AGE_EVENT);
		expect(rpc?.data).toMatchObject({
			kind: "reap_failed",
			id: "bash_9",
			autoReapMinutes: 60,
			reason: "EPERM: operation not permitted",
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toContain("bash_9");
		expect(messages[0]?.content).toContain("EPERM: operation not permitted");
		expect(messages[0]?.content).toContain('kill_bash({ bash_id: "bash_9" })');
		expect(notices.map((notice) => notice.level)).toEqual(["warning"]);

		vi.advanceTimersByTime(10 * MINUTE);
		const rpcKinds = emitted
			.filter((entry) => entry.via === "rpc" && entry.name === TERMINAL_BACKGROUND_AGE_EVENT)
			.map((entry) => Reflect.get(Object(entry.data), "kind"));
		expect(rpcKinds).toEqual(["reap_failed", "running"]);
	});
});
