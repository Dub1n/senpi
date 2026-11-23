import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { omoTaskDensityCard } from "../../src/modes/interactive/components/omo-task-density.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolDensityRow, type DensityCardSource } from "../../src/modes/interactive/components/tool-density-row.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

const width = 48;
const pad = (line: string) => line.padEnd(width);

function rows(toolName: string, args: unknown, details: unknown, expanded: boolean, grouped = true): string[] {
	const view = omoTaskDensityCard({ toolName, args, result: { details, isError: false } });
	if (!view) return [];
	const source: DensityCardSource = {
		densityExpanded: expanded,
		renderDensityCard: () => view,
		renderDensitySummary: () => [],
		render: () => [],
		invalidate: () => {},
		getBackgroundPainter: () => undefined,
		setExpanded: () => {},
	};
	const row = new ToolDensityRow(source, () => {});
	row.setLayout(grouped, true, true);
	return row.render(width).map(stripTerminalSequences);
}

describe("OmO tool density cards", () => {
	beforeAll(() => initTheme("dark"));

	describe.each([
		["compact", false],
		["grouped", true],
	] as const)("%s nickname labels", (_density, grouped) => {
		it("prefers the spawn nickname without replacing the handle or summary", () => {
			const args = { prompt: "Hidden prompt" };
			const details = {
				mode: "spawn",
				status: "running",
				task_id: "st_123",
				name: "review-worker",
				nickname: "\x1b[31mSelene\x1b[0m",
				task_summary: "Review",
			};
			expect(rows("task", args, details, false, grouped)).toContain(
				pad(' ╶─ + task • Selene (review-worker) "Review"'),
			);
		});

		it("keeps repeated nicknames separate and preserves legacy and failed batch entries", () => {
			const items = [
				{ task_id: "st_123", name: "review", nickname: "Selene", task_summary: "Check", status: "running" },
				{ task_id: "st_456", nickname: "Selene", status: "pending" },
				{ task_id: "st_789", name: "legacy", status: "pending" },
				{ task_id: "", nickname: "Not spawned", status: "error", error_message: "no capacity" },
			];
			const details = { mode: "spawn", task_id: "st_123", status: "running", items };
			expect(rows("task", { tasks: [] }, details, true, grouped)).toEqual([
				"",
				pad(""),
				pad(" ╭─ + task • st_123"),
				pad(" │ Selene (review) · Check · running"),
				pad(" │ Selene (st_456) · pending"),
				pad(" │ st_789 · legacy · pending"),
				pad(" │ task · error · no capacity"),
				pad(" ╰─"),
				pad(""),
			]);
		});

		it.each([
			{ nickname: "Selene", expected: "Selene (review-worker)" },
			{ nickname: "review-worker", expected: "review-worker (st_123)" },
			{ nickname: " \n\t ", expected: "st_123" },
			{ nickname: 123, expected: "st_123" },
			{ nickname: undefined, expected: "st_123" },
		])("uses $expected for a resolved send", ({ nickname, expected }) => {
			const args = { to: "st_123", message: "Keep the message" };
			const details = {
				kind: "steered",
				task_id: "st_123",
				name: "review-worker",
				status: "running",
				delivered: "steer",
				nickname,
			};
			expect(rows("task_send", args, details, true, grouped)).toEqual([
				"",
				pad(""),
				pad(` ╭─ → messaged • ${expected}`),
				pad(" │ steered"),
				pad(" │ Keep the message"),
				pad(" ╰─"),
				pad(""),
			]);
		});

		it("keeps the original target on unresolved or unauthorized sends", () => {
			const args = { to: "review-worker", message: "Try later" };
			for (const kind of ["not_found", "scope_denied"]) {
				const details = { kind, task_id: "st_123", name: "resolved", nickname: "Selene", reason: "unavailable" };
				expect(rows("task_send", args, details, false, grouped)).toContain(pad(" ╶─ ✗ messaged • review-worker"));
			}
		});

		it("prefers the output snapshot nickname over the lookup argument or top-level details", () => {
			const args = { name: "lookup-worker" };
			const details = {
				kind: "status",
				nickname: "Wrong level",
				snapshot: { task_id: "st_123", nickname: "Selene", status: "running" },
			};
			expect(rows("task_output", args, details, false, grouped)).toContain(
				pad(" ╶─ ◉ peek • status Selene (st_123)"),
			);
			const unresolved = { ...details, kind: "not_found", reason: "unavailable" };
			expect(rows("task_output", args, unresolved, false, grouped)).toContain(pad(" ╶─ ✗ peek • status st_123"));
		});
	});

	it("keeps the original multiline message for a confirmed steer", () => {
		const args = { to: "st_123", message: "first line\nsecond line" };
		const details = { kind: "steered", task_id: "st_123", status: "running", delivered: "steer" };
		expect(rows("task_send", args, details, true)).toEqual([
			"",
			pad(""),
			pad(" ╭─ → messaged • st_123"),
			pad(" │ steered"),
			pad(" │ first line"),
			pad(" │ second line"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("shows the requested tail limit rather than claiming a line count", () => {
		const args = { task_id: "st_123", mode: "tail", tail_lines: 9 };
		const details = {
			kind: "transcript",
			mode: "tail",
			source: "event-log",
			transcript: "assistant: ready",
			truncated: false,
			snapshot: {
				task_id: "st_123",
				status: "running",
				model: "provider/model",
				execution_mode: "process",
				residency_state: "resident",
				parent_session_id: "parent",
				root_session_id: "root",
				age_ms: 100,
			},
		};
		expect(rows("task_output", args, details, true)).toEqual([
			"",
			pad(""),
			pad(" ╭─ ◉ peek • tail st_123"),
			pad(" │ status: running"),
			pad(" │ model: provider/model"),
			pad(" │ requested tail: 9 lines"),
			pad(" │ source: event-log"),
			pad(" │ transcript: assistant: ready"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("shows the created task identity without redundant running state", () => {
		const args = {
			prompt: "Inspect it",
			description: "Inspect it",
			subagent_type: "worker",
			run_in_background: true,
		};
		const details = {
			task_id: "st_123",
			status: "running",
			mode: "spawn",
			subagent_type: "worker",
			run_in_background: true,
		};
		expect(rows("task", args, details, false)).toEqual([
			"",
			pad(""),
			pad(' ╶─ + task • st_123 "Inspect it"'),
			pad(""),
		]);
	});

	it("falls back for unrecognized producer details", () => {
		for (const result of [
			undefined,
			{ isError: false },
			{ details: { kind: "other" }, isError: false },
			{ details: { kind: "status" }, isError: false },
		]) {
			expect(omoTaskDensityCard({ toolName: "task_output", args: {}, result })).toBeUndefined();
		}
	});

	it("keeps a failed send distinguishable with its diagnostic", () => {
		expect(
			rows(
				"task_send",
				{ to: "st_123", message: "try again" },
				{
					kind: "send_failed",
					to: "st_123",
					reason: "host unavailable",
				},
				true,
			),
		).toEqual([
			"",
			pad(""),
			pad(" ╭─ ✗ messaged • st_123"),
			pad(" │ send failed: host unavailable"),
			pad(" │ try again"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("retains every task identifier and failed batch item", () => {
		expect(
			rows(
				"task",
				{ tasks: [{ prompt: "first" }, { prompt: "second" }] },
				{
					mode: "spawn",
					task_id: "st_123",
					status: "running",
					run_in_background: true,
					items: [
						{ task_id: "st_123", status: "running", name: "first" },
						{ task_id: "st_456", status: "pending", name: "second" },
						{ task_id: "", status: "error", error_message: "no capacity" },
					],
				},
				true,
			),
		).toEqual([
			"",
			pad(""),
			pad(" ╭─ + task • st_123"),
			pad(" │ st_123 · first · running"),
			pad(" │ st_456 · second · pending"),
			pad(" │ task · error · no capacity"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("shows full transcript source and truncation in compact mode", () => {
		expect(
			rows(
				"task_output",
				{ task_id: "st_123", mode: "full" },
				{
					kind: "transcript",
					mode: "full",
					source: "session-jsonl",
					transcript: "assistant: finished",
					truncated: true,
					snapshot: {
						task_id: "st_123",
						status: "completed",
						model: "provider/model",
						execution_mode: "process",
						residency_state: "resident",
						parent_session_id: "parent",
						root_session_id: "root",
						age_ms: 100,
					},
				},
				true,
				false,
			),
		).toEqual([
			"",
			pad(""),
			pad(" ╭─ ◉ peek • full st_123"),
			pad(" │ status: completed"),
			pad(" │ model: provider/model"),
			pad(" │ source: session-jsonl"),
			pad(" │ truncated: yes"),
			pad(" │ transcript: assistant: finished"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("shows a lookup failure rather than claiming a successful peek", () => {
		expect(
			rows(
				"task_output",
				{ task_id: "st_missing" },
				{ kind: "not_found", reason: "task missing", known_tasks: [] },
				true,
			),
		).toEqual([
			"",
			pad(""),
			pad(" ╭─ ✗ peek • status st_missing"),
			pad(" │ error: task missing"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("renders producer-shaped status data through the real grouped transcript", async () => {
		const surface = await explorationSurface(true);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			invoke(surface.mode, "renderSessionItems", [
				fauxAssistantMessage(
					{ type: "toolCall", id: "peek-1", name: "task_output", arguments: { task_id: "st_123" } },
					{ stopReason: "toolUse", timestamp: 0 },
				),
				{
					role: "toolResult",
					toolName: "task_output",
					toolCallId: "peek-1",
					timestamp: 0,
					isError: false,
					content: [{ type: "text", text: "OmO status" }],
					details: {
						kind: "status",
						snapshot: {
							task_id: "st_123",
							status: "running",
							model: "provider/model",
							execution_mode: "process",
							residency_state: "resident",
							parent_session_id: "parent",
							root_session_id: "root",
							age_ms: 100,
						},
					},
				},
			]);
			surface.chat.setToolDisplayDensity("grouped");
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
				"",
				pad(""),
				pad(" ╭─ ◉ peek • status st_123"),
				pad(" │ status: running"),
				pad(" │ model: provider/model"),
				pad(" ╰─"),
				pad(""),
			]);
		} finally {
			surface.cleanup();
		}
	});
});
