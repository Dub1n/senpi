import { stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import type { LoopGuardDetection } from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import loopGuardExtension from "../../src/core/extensions/builtin/loop-guard/index.ts";
import {
	buildLoopGuardBlockReason,
	LOOP_GUARD_NOTICE_CUSTOM_TYPE,
} from "../../src/core/extensions/builtin/loop-guard/notice.ts";
import { renderLoopGuardNotice } from "../../src/core/extensions/builtin/loop-guard/renderer.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { ToolDensityRow } from "../../src/modes/interactive/components/tool-density-row.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type SentMessage = {
	message: { customType: string; content: string; display: boolean; details?: LoopGuardDetection };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
};

interface LoopGuardHarness {
	handlers: Map<string, Handler[]>;
	sent: SentMessage[];
	renderers: Map<string, unknown>;
	fire: (eventName: string, event: unknown) => void;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function createLoopGuardHarness(): LoopGuardHarness {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	const renderers = new Map<string, unknown>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => {
			sent.push({ message, options });
		},
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			renderers.set(customType, renderer);
		},
	} as unknown as ExtensionAPI;
	loopGuardExtension(pi);
	const fire = (eventName: string, event: unknown): void => {
		for (const handler of handlers.get(eventName) ?? []) {
			void handler(event, {} as ExtensionContext);
		}
	};
	return { handlers, sent, renderers, fire };
}

function toolStart(fire: LoopGuardHarness["fire"], toolName: string, args: unknown, callId = "c1"): void {
	fire("tool_execution_start", { type: "tool_execution_start", toolCallId: callId, toolName, args });
}

function userInput(fire: LoopGuardHarness["fire"], source: "interactive" | "rpc" | "extension"): void {
	fire("input", { type: "input", text: "go", source });
}

describe("loop-guard extension", () => {
	it("gives polling tools a terminal recovery action instead of argument mutation", () => {
		const reason = buildLoopGuardBlockReason("bash_output", 1);
		const normalized = reason.toLowerCase();

		expect(normalized).toContain("arm a monitor");
		expect(normalized).toContain("stop polling");
		expect(normalized).not.toContain("change an argument");
	});

	it("keeps non-polling recovery actionable without requiring a monitor", () => {
		const reason = buildLoopGuardBlockReason("read", 1);
		const normalized = reason.toLowerCase();

		expect(normalized).toContain("re-plan");
		expect(normalized).not.toContain("monitor");
	});

	it("registers the notice renderer under the notice custom type", () => {
		const harness = createLoopGuardHarness();
		expect(harness.renderers.get(LOOP_GUARD_NOTICE_CUSTOM_TYPE)).toBe(renderLoopGuardNotice);
	});

	it("stays silent for ordinary varied tool use", () => {
		const harness = createLoopGuardHarness();
		toolStart(harness.fire, "bash", { command: "git status" });
		toolStart(harness.fire, "read", { path: "src/a.ts" });
		toolStart(harness.fire, "bash", { command: "npm run check" });
		toolStart(harness.fire, "read", { path: "src/b.ts" });
		expect(harness.sent).toHaveLength(0);
	});

	it("fires the identical reminder on the third identical call and steers it", () => {
		const harness = createLoopGuardHarness();
		for (let i = 0; i < 3; i++) {
			toolStart(harness.fire, "webfetch", { url: "https://example.com", format: "markdown" });
		}
		expect(harness.sent).toHaveLength(1);
		const notice = harness.sent[0];
		expect(notice?.message.customType).toBe(LOOP_GUARD_NOTICE_CUSTOM_TYPE);
		expect(notice?.message.display).toBe(true);
		expect(notice?.message.content).toContain("IDENTICAL TOOL CALLS");
		expect(notice?.message.content).toContain("`webfetch` 3 times");
		expect(notice?.options?.deliverAs).toBe("steer");
		expect(notice?.options?.triggerTurn).toBe(false);
	});

	it("escalates instead of spamming: silent at 4-5, fires again at 6", () => {
		const harness = createLoopGuardHarness();
		for (let i = 0; i < 5; i++) toolStart(harness.fire, "bash", { command: "echo stuck" });
		expect(harness.sent).toHaveLength(1);
		toolStart(harness.fire, "bash", { command: "echo stuck" });
		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[1]?.message.content).toContain("6 times");
	});

	it("uses the distinct similar-call prompt for near-identical runs", () => {
		const harness = createLoopGuardHarness();
		const offsets = [1, 201, 401, 601, 801];
		for (const offset of offsets) {
			toolStart(harness.fire, "read", { path: "src/app.ts", offset, limit: 200 });
		}
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.content).toContain("NEAR-IDENTICAL TOOL CALLS");
		expect(harness.sent[0]?.message.content).not.toContain("LOOP GUARD - IDENTICAL TOOL CALLS");
	});

	it("stays silent for near-identical reads targeting distinct paths", () => {
		const harness = createLoopGuardHarness();
		const basePath =
			"/Users/yeongyu/local-workspaces/senpi/packages/coding-agent/src/core/extensions/builtin/loop-guard";
		for (const fileName of ["detectors.ts", "notice.ts", "policy.ts", "similarity.ts", "tracker.ts"]) {
			toolStart(harness.fire, "read", { path: `${basePath}/${fileName}` });
		}
		expect(harness.sent).toHaveLength(0);
	});

	it("uses the distinct cycle prompt for repeating rotations", () => {
		const harness = createLoopGuardHarness();
		for (let i = 0; i < 3; i++) {
			toolStart(harness.fire, "eval", { code: "peek()" }, `eval-${i}`);
			toolStart(harness.fire, "bash_output", { bash_id: "s1" }, `out-${i}`);
		}
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.content).toContain("REPEATING TOOL-CALL PATTERN");
		expect(harness.sent[0]?.message.content).toContain("[eval -> bash_output] 3 times");
	});

	it("resets on real user input and does not reset on extension input", () => {
		const harness = createLoopGuardHarness();
		toolStart(harness.fire, "read", { path: "a.ts" });
		toolStart(harness.fire, "read", { path: "a.ts" });
		userInput(harness.fire, "extension");
		toolStart(harness.fire, "read", { path: "a.ts" });
		expect(harness.sent).toHaveLength(1);
		userInput(harness.fire, "interactive");
		for (let i = 0; i < 3; i++) toolStart(harness.fire, "read", { path: "a.ts" });
		expect(harness.sent).toHaveLength(2);
	});

	it("resets on session_start", () => {
		const harness = createLoopGuardHarness();
		for (let i = 0; i < 3; i++) toolStart(harness.fire, "read", { path: "a.ts" });
		expect(harness.sent).toHaveLength(1);
		harness.fire("session_start", { type: "session_start" });
		for (let i = 0; i < 3; i++) toolStart(harness.fire, "read", { path: "a.ts" });
		expect(harness.sent).toHaveLength(2);
	});

	it("renders the notice as an accent box with a title and why line", () => {
		initTheme("dark");
		const harness = createLoopGuardHarness();
		for (let i = 0; i < 3; i++) toolStart(harness.fire, "read", { path: "a.ts" });
		const notice = harness.sent[0];
		expect(notice).toBeDefined();
		if (notice === undefined) return;
		const component = renderLoopGuardNotice(
			{
				role: "custom",
				customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
				content: notice.message.content,
				display: true,
				timestamp: 0,
				...(notice.message.details !== undefined ? { details: notice.message.details } : {}),
			},
			{ expanded: false, outputPad: 0 },
			theme,
		);
		const text = (component?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
		expect(text).toContain("Loop guard");
		expect(text).toContain("identical calls ×3 (read)");
		expect(text).toContain("reuse the result or change the call");
	});

	it.each([false, true])("uses Bash's accent and the icon toggle in dense cards (grouped=%s)", async (grouped) => {
		initTheme("dark");
		const message = {
			role: "custom",
			customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
			content: "Repeated tool calls.",
			display: true,
			timestamp: 0,
			details: { kind: "identical", toolName: "bash_output", count: 3, fingerprint: "repeat" },
		} as const;
		const card = new CustomMessageComponent(message, (_message, options, palette) =>
			renderLoopGuardNotice(message, options, palette),
		);
		try {
			let colorIcons = false;
			const row = new ToolDensityRow(
				card,
				() => {},
				() => ({ colorFrames: true, colorNames: true, colorIcons }),
			);
			row.setLayout(grouped, true, true);
			for (const expanded of [false, true]) {
				colorIcons = expanded;
				card.setExpanded(expanded);
				const rows = row.render(100);
				const plain = rows.map(stripTerminalSequences);
				const frame = expanded ? "╭─" : "╶─";
				expect(plain[2]?.trimEnd()).toBe(` ${frame} ! Loop guard • identical calls ×3 (bash_output)`);
				if (expanded) {
					expect(plain[3]?.trimEnd()).toBe(
						" │ Same tool, same arguments, again. The agent was told to reuse the result or change the call.",
					);
					expect(plain[4]?.trimEnd()).toBe(
						" │ tool bash_output · 3 consecutive identical calls when the reminder fired",
					);
				}
				const terminal = new xterm.Terminal({ cols: 101, rows: 20, allowProposedApi: true });
				try {
					const samples = theme.fg("syntaxFunction", "B") + theme.fg("text", "T");
					await new Promise<void>((resolve) => terminal.write([samples, ...rows].join("\x1b[0m\r\n"), resolve));
					const fg = (y: number, x: number) => {
						const cell = terminal.buffer.active.getLine(y)?.getCell(x);
						if (!cell) throw new Error(`Missing terminal cell ${x},${y}`);
						return [cell.getFgColorMode(), cell.getFgColor()];
					};
					expect(fg(3, 1)).toEqual(fg(0, 0));
					expect(fg(3, 6)).toEqual(fg(0, 0));
					expect(fg(3, 4)).toEqual(fg(0, colorIcons ? 0 : 1));
				} finally {
					terminal.dispose();
				}
			}
		} finally {
			card.dispose();
		}
	});
});
