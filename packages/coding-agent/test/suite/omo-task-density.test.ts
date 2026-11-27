import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../src/core/extensions/session-control-types.ts";
import {
	omoTaskDensityCard,
	omoTaskDensityProjection,
} from "../../src/modes/interactive/components/omo-task-density.ts";
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
	it("replays model context from earlier task receipts by ID without applying a later run retroactively", async () => {
		const surface = await explorationSurface(true);
		try {
			if (!(surface.chat instanceof ExplorationTranscriptContainer)) throw new TypeError("Expected transcript");
			const result = (id: string, name: string, args: JsonObject, details: object) => [
				fauxAssistantMessage(
					{ type: "toolCall", id, name, arguments: args },
					{ stopReason: "toolUse", timestamp: 0 },
				),
				{ role: "toolResult", toolName: name, toolCallId: id, timestamp: 0, isError: false, content: [], details },
			];
			const spawn = (id: string, model: string, effort: string, epoch: number) =>
				result(
					id,
					"task",
					{},
					{
						mode: "spawn",
						task_id: "st_worker",
						child_session_id: "session-worker",
						run_epoch: epoch,
						nickname: "Kale",
						status: "running",
						resolved_model: { display: model, reasoning: effort },
					},
				);
			const send = (id: string, taskId: string, nickname: string, epoch?: number) =>
				result(
					id,
					"task_send",
					{ to: taskId, message: "Continue" },
					{ kind: "steered", task_id: taskId, nickname, run_epoch: epoch, delivered: "steer", status: "running" },
				);
			invoke(surface.mode, "renderSessionItems", [
				...spawn("spawn-a", "Luna", "LOW", 1),
				{
					role: "custom",
					customType: SESSION_CONTROL_DELIVERY_TYPE,
					content: "Here is an update",
					display: true,
					timestamp: 0,
					details: {
						delivery_id: "test-delivery",
						source: "session_control",
						deliverAs: "followUp",
						sender: { kind: "agent", session_id: "session-worker", name: "Kale" },
					},
				},
				...send("send-a", "st_worker", "Kale"),
				...send("send-other", "st_other", "Other"),
				...spawn("spawn-b", "Sol", "HIGH", 2),
				...send("send-b", "st_worker", "Kale"),
				...send("send-old", "st_worker", "Kale", 1),
			]);
			surface.chat.setToolDisplayDensity("compact");
			const rendered = surface.chat.render(90).map(stripTerminalSequences);
			expect(rendered.join("\n")).toContain("from • Kale · Luna low");
			const messages = rendered.filter((line) => line.includes("messaged •")).map((line) => line.trim());
			expect(messages.map((line) => line.slice(line.indexOf("messaged")))).toEqual([
				"messaged • Kale · Luna low",
				"messaged • Other",
				"messaged • Kale · Sol high",
				"messaged • Kale · Luna low",
			]);
		} finally {
			surface.cleanup();
		}
	});
	beforeAll(() => initTheme("dark"));

	describe.each([
		["compact", false],
		["grouped", true],
	] as const)("%s nickname labels", (_density, grouped) => {
		it("uses the spawn nickname as the compact identity", () => {
			const args = { prompt: "Hidden prompt" };
			const details = {
				mode: "spawn",
				status: "running",
				task_id: "st_123",
				name: "review-worker",
				nickname: "\x1b[31mSelene\x1b[0m",
				task_summary: "Review",
			};
			expect(rows("task", args, details, false, grouped)).toContain(pad(' ╶─ + task • Selene · "Review"'));
		});

		it("shows each batch worker's identity, model, and lowercase effort in source order", () => {
			const items = [
				{
					task_id: "st_123",
					name: "review",
					nickname: "Deimos",
					task_summary: "Implement",
					status: "running",
					subagent_type: "deep-low",
					resolved_model: { display: "GPT-6 Luna", model_id: "gpt-6-luna", reasoning: "LOW" },
				},
				{
					task_id: "st_456",
					name: "review",
					nickname: "Io",
					task_summary: "Check",
					status: "running",
					category: "quick",
					resolved_model: { model_id: "gpt-6.2-sol-fast", reasoning_effort: "HIGH" },
				},
			];
			const details = { mode: "spawn", task_id: "st_123", status: "running", items };
			expect(rows("task", { tasks: [] }, details, false, grouped)).toContain(
				pad(" ╶─ + task • Deimos (Luna low) · Io (Sol high)"),
			);
			expect(rows("task", { tasks: [] }, details, true, grouped)).toContain(
				pad(' ╭─ + task • Deimos · Luna low · "Implement"'),
			);
			expect(rows("task", { tasks: [] }, details, true, grouped)).toContain(
				pad(' ├─ + task • Io · Sol high · "Check"'),
			);
		});

		it("keeps every batch worker's ID, agent, prompt, and unsuccessful status in its own section", () => {
			const args = {
				tasks: [
					{ prompt: "Implement the route", task_summary: "Implement" },
					{ prompt: "Verify the route", task_summary: "Verify" },
				],
			};
			const details = {
				mode: "spawn",
				task_id: "st_123",
				status: "running",
				items: [
					{
						task_id: "st_123",
						name: "review",
						nickname: "Deimos",
						task_summary: "Implement",
						status: "running",
						subagent_type: "deep-low",
						resolved_model: { display: "Luna", reasoning: "low" },
					},
					{
						task_id: "st_456",
						name: "check",
						nickname: "Io",
						task_summary: "Verify",
						status: "error",
						category: "quick",
						error_message: "provider unavailable",
						resolved_model: { display: "Sol", reasoning_effort: "high" },
					},
				],
			};
			const view = omoTaskDensityCard({ toolName: "task", args, result: { details, isError: false } });
			expect(view?.format).toBe("structured");
			if (view?.format !== "structured") throw new Error("Expected structured task card");
			expect(view.statusGlyph).toBe("+");
			expect(view.heading.details).toEqual([
				[
					{ text: "Deimos", role: "text" },
					{ text: " (Luna low)", role: "dim" },
				],
				[
					{ text: "Io", role: "text" },
					{ text: " (Sol high)", role: "dim" },
				],
			]);
			expect(view.expandedHeading?.details).toEqual([
				[{ text: "Deimos", role: "text" }],
				[{ text: "Luna low", role: "dim" }],
				[{ text: '"Implement"', role: "dim", italic: true }],
			]);
			expect(view.body).toEqual([
				{
					type: "text",
					lines: [
						[{ text: "id: st_123", role: "text" }],
						"agent: deep-low",
						"status: running",
						[{ text: "Implement the route", role: "dim", italic: true }],
					],
				},
			]);
			expect(view.sections).toEqual([
				{
					placement: "frame",
					heading: {
						kind: "task",
						heading: {
							details: [
								[{ text: "Io", role: "text" }],
								[{ text: "Sol high", role: "dim" }],
								[{ text: '"Verify"', role: "dim", italic: true }],
							],
						},
						statusGlyph: "✗",
					},
					body: [
						{
							type: "text",
							lines: [
								[{ text: "id: st_456", role: "text" }],
								"agent: quick",
								"status: error",
								"detail: provider unavailable",
								[{ text: "Verify the route", role: "dim", italic: true }],
							],
						},
					],
				},
			]);
			expect(rows("task", args, details, true, grouped)).toContain(pad(" │ detail: provider unavailable"));

			const reversed = { ...details, items: [...details.items].reverse() };
			const reversedView = omoTaskDensityCard({
				toolName: "task",
				args,
				result: { details: reversed, isError: false },
			});
			expect(reversedView?.format).toBe("structured");
			if (reversedView?.format !== "structured") throw new Error("Expected structured reversed batch card");
			expect(reversedView.statusGlyph).toBe("✗");
			expect(reversedView.sections[0]?.heading).toMatchObject({ statusGlyph: "+" });
		});

		it("projects structured batch items directly as standalone Task cards", () => {
			const projection = omoTaskDensityProjection({
				toolName: "task",
				args: {
					tasks: [
						{ prompt: "Implement the route", task_summary: "Implement" },
						{ prompt: "Verify the route", task_summary: "Verify" },
					],
				},
				result: {
					isError: false,
					details: {
						mode: "spawn",
						task_id: "st_123",
						status: "running",
						items: [
							{ task_id: "st_123", nickname: "Deimos", status: "running", task_summary: "Implement" },
							{
								task_id: "st_456",
								nickname: "Io",
								status: "error",
								task_summary: "Verify",
								error_message: "provider unavailable",
							},
						],
					},
				},
			});
			expect(projection?.type).toBe("members");
			if (projection?.type !== "members") throw new Error("Expected standalone Task members");
			expect(
				projection.summary.heading.details?.map((line) => (typeof line === "string" ? line : line[0]?.text)),
			).toEqual(["Deimos", "Io"]);
			expect(projection.summary.body).toEqual([]);
			expect(projection.summary.sections).toEqual([]);
			expect(
				projection.members.map(({ heading, statusGlyph, body, sections }) => ({
					identity: heading.details?.[0],
					statusGlyph,
					body: body.flatMap((block) => (block.type === "text" ? block.lines : [])),
					sections,
				})),
			).toEqual([
				{
					identity: [{ text: "Deimos", role: "text" }],
					statusGlyph: "+",
					body: [
						[{ text: "id: st_123", role: "text" }],
						"status: running",
						[{ text: "Implement the route", role: "dim", italic: true }],
					],
					sections: [],
				},
				{
					identity: [{ text: "Io", role: "text" }],
					statusGlyph: "✗",
					body: [
						[{ text: "id: st_456", role: "text" }],
						"status: error",
						"detail: provider unavailable",
						[{ text: "Verify the route", role: "dim", italic: true }],
					],
					sections: [],
				},
			]);
		});

		it("uses effective model metadata, keeps Default, and never invents missing effort", () => {
			const details = {
				mode: "spawn",
				task_id: "st_123",
				status: "running",
				nickname: "Deimos",
				task_summary: "Patch",
				resolved_model: { display: "Old Model", reasoning: "max" },
				effective_model: { display: "Default", reasoning: "LOW", source: "fallback" },
				fallback_attempts: [{ display: "Fallback Luna", reasoning: "HIGH" }],
			};
			expect(rows("task", {}, details, false, grouped)).toContain(
				pad(' ╶─ + task • Deimos · Default low · "Patch"'),
			);
			const noEffort = {
				...details,
				effective_model: { display: "Sol" },
			};
			expect(rows("task", {}, noEffort, false, grouped)).toContain(pad(' ╶─ + task • Deimos · Sol · "Patch"'));
			const view = omoTaskDensityCard({ toolName: "task", args: {}, result: { details, isError: false } });
			expect(view?.format).toBe("structured");
			if (view?.format !== "structured") throw new Error("Expected structured task card");
			expect(view.body[0]?.type).toBe("text");
			if (view.body[0]?.type !== "text") throw new Error("Expected text body");
			expect(view.body[0].lines).toContain("fallbacks: Fallback Luna high");
		});

		it.each([
			{ nickname: "Selene", expected: "Selene" },
			{ nickname: "review-worker", expected: "review-worker" },
			{ nickname: " \n\t ", expected: "id: st_123" },
			{ nickname: 123, expected: "id: st_123" },
			{ nickname: undefined, expected: "id: st_123" },
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
				pad(" │ id: st_123"),
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
			expect(rows("task_output", args, details, false, grouped)).toContain(pad(" ╶─ ◉ peek • Selene · running"));
			const unresolved = { ...details, kind: "not_found", reason: "unavailable" };
			expect(rows("task_output", args, unresolved, false, grouped)).toContain(pad(" ╶─ ✗ peek • id: st_123"));
		});
	});

	it("keeps the original multiline message for a confirmed steer", () => {
		const args = { to: "st_123", message: "first line\nsecond line" };
		const details = { kind: "steered", task_id: "st_123", status: "running", delivered: "steer" };
		expect(rows("task_send", args, details, true)).toEqual([
			"",
			pad(""),
			pad(" ╭─ → messaged • id: st_123"),
			pad(" │ steered"),
			pad(" │ id: st_123"),
			pad(" │ first line"),
			pad(" │ second line"),
			pad(" ╰─"),
			pad(""),
		]);
	});

	it("shows tail status in the title and a leading ellipsis in the transcript", () => {
		const args = { task_id: "st_123", mode: "tail", tail_lines: 9 };
		const details = {
			kind: "transcript",
			mode: "tail",
			source: "event-log",
			transcript: "assistant: ready",
			truncated: true,
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
			expect.stringContaining("peek • id: st_123 · provider/model ·"),
			pad(" │ id: st_123"),
			pad(" │ model: provider/model"),
			pad(" │ transcript:"),
			pad(" │ …"),
			pad(" │ assistant: ready"),
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
			pad(' ╶─ + task • id: st_123 · "Inspect it"'),
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

	it("retains every task identifier and unsuccessful batch item", () => {
		const result = rows(
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
		);
		expect(result).toContain(pad(" ╭─ + task • id: st_123"));
		expect(result).toContain(pad(" ├─ ○ task • id: st_456"));
		expect(result).toContain(pad(" ├─ ✗ task"));
		expect(result).toContain(pad(" │ id: st_123"));
		expect(result).toContain(pad(" │ id: st_456"));
		expect(result).toContain(pad(" │ status: pending"));
		expect(result).toContain(pad(" │ status: error"));
		expect(result).toContain(pad(" │ detail: no capacity"));
	});

	it("uses the actual effective model and lowercase effort in task status rows", () => {
		const details = {
			kind: "status",
			snapshot: {
				task_id: "st_123",
				status: "running",
				resolved_model: { display: "Old Model", reasoning: "max" },
				effective_model: { display: "Luna", reasoning: "HIGH" },
			},
		};
		expect(rows("task_output", { task_id: "st_123" }, details, true)).toContain(pad(" │ model: Luna high"));
	});

	it("uses a no-progress nickname while keeping the task ID in expanded details", () => {
		const result = rows(
			"task_output",
			{ task_id: "st_123" },
			{
				kind: "no_progress",
				task_id: "st_123",
				nickname: "Selene",
				status: "running",
				reason: "unchanged",
			},
			true,
		);
		expect(result).toContain(pad(" ╭─ ◉ peek • Selene · running"));
		expect(result).toContain(pad(" │ id: st_123"));
	});

	it("shows supplied task-send model context without inventing missing effort", () => {
		const details = {
			kind: "steered",
			task_id: "st_123",
			name: "review-worker",
			nickname: "Selene",
			status: "running",
			delivered: "steer",
			resolved_model: { display: "Sol", reasoning_effort: "HIGH" },
		};
		const view = omoTaskDensityCard({
			toolName: "task_send",
			args: { to: "st_123", message: "Continue" },
			result: { details, isError: false },
		});
		expect(view?.format).toBe("structured");
		if (view?.format !== "structured") throw new Error("Expected structured task-send card");
		expect(view.heading.details).toEqual([[{ text: "Selene", role: "text" }], [{ text: "Sol high", role: "dim" }]]);
		expect(view.body).toEqual([
			{
				type: "text",
				lines: [
					"steered",
					[{ text: "id: st_123", role: "text" }],
					[{ text: "Continue", role: "dim", italic: true }],
				],
			},
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
			expect.stringContaining("peek • id: st_123 · provider/model ·"),
			pad(" │ id: st_123"),
			pad(" │ model: provider/model"),
			pad(" │ transcript:"),
			pad(" │ assistant: finished"),
			pad(" │ …"),
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
		).toEqual(["", pad(""), pad(" ╭─ ✗ peek • id: st_missing"), pad(" │ error: task missing"), pad(" ╰─"), pad("")]);
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
				expect.stringContaining("peek • id: st_123 · provider/model ·"),
				pad(" │ id: st_123"),
				pad(" │ model: provider/model"),
				pad(" ╰─"),
				pad(""),
			]);
		} finally {
			surface.cleanup();
		}
	});
});
