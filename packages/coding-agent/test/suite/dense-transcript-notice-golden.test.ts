import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../src/core/extensions/session-control-types.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../src/core/messages.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

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

function click(surface: Awaited<ReturnType<typeof fixture>>, y: number) {
	const height = surface.chat.render(width).length;
	return surface.chat.handleMouse({
		type: "click",
		button: "left",
		x: 6,
		y,
		screenX: 6,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe("dense transcript notices", () => {
	it.each(["compact", "grouped"] as const)("folds and expands a compaction in %s", async (density) => {
		const surface = await fixture(density);
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCompactionSummaryMessage("Preserved fixture summary.", 425730, new Date(0).toISOString()),
			);
			const folded = surface.chat.render(width).map(stripTerminalSequences);
			expect(folded).toEqual(["", row(""), row(" ╶─ ✓ compacted from 425,730 tokens"), row("")]);
			expect(click(surface, 2)?.handled).toBe(true);
			const expanded = surface.chat.render(width).map(stripTerminalSequences);
			expect(expanded).toEqual([
				"",
				row(""),
				row(" ╭─ ✓ compacted from 425,730 tokens"),
				row(" │ Preserved fixture summary."),
				row(" ╰─"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)(
		"shows retained item counts, not post-compaction tokens, in %s",
		async (density) => {
			const surface = await fixture(density);
			try {
				invoke(
					surface.mode,
					"addMessageToChat",
					createCompactionSummaryMessage(
						"OpenAI remote compaction retained 1 native item (responses-v2).",
						361726,
						new Date(0).toISOString(),
						{
							schema: "senpi.compaction.openai-remote.v1",
							mode: "openai-remote",
							transport: "responses-v2",
							retainedInputItemCount: 1,
							requestInputItemCount: 1151,
						},
					),
				);
				expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
					"",
					row(""),
					row(" ╶─ ✓ compacted from 361,726 tokens · 1 retained item"),
					row(""),
				]);
				expect(click(surface, 2)?.handled).toBe(true);
				expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
					"",
					row(""),
					row(" ╭─ ✓ compacted from 361,726 tokens · 1 retained item"),
					row(" │ OpenAI remote compaction retained 1 native item (responses-v2) from 1,151"),
					row(" │ OpenAI input items."),
					row(" ╰─"),
					row(""),
				]);
			} finally {
				surface.cleanup();
			}
		},
	);

	it("preserves a noncanonical provider summary without treating request usage as retained context", async () => {
		const surface = await fixture("compact");
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCompactionSummaryMessage(
					"Keep both decisions.\n\nThe second is still pending.",
					12000,
					new Date(0).toISOString(),
					{
						schema: "senpi.compaction.openai-remote.v1",
						transport: "compact-endpoint",
						requestInputItemCount: 7,
						retainedInputItemCount: 2,
						usage: { input_tokens: 12000, output_tokens: 9400, total_tokens: 21400 },
					},
				),
			);
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
				"",
				row(""),
				row(" ╭─ ✓ compacted from 12,000 tokens · 2 retained items"),
				row(" │ Keep both decisions."),
				row(" │"),
				row(" │ The second is still pending."),
				row(" │"),
				row(" │ OpenAI remote compact API: 2 retained items from 7 OpenAI input items"),
				row(" ╰─"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it.each(["compact", "grouped"] as const)("keeps agent and relay attribution in %s", async (density) => {
		const surface = await fixture(density);
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCustomMessage(
					SESSION_CONTROL_DELIVERY_TYPE,
					"[gateway provenance for the model]\nOriginal fixture body.",
					true,
					{
						delivery_id: "fixture-delivery",
						source: "session_control",
						deliverAs: "followUp",
						sender: { kind: "agent", session_id: "peer", name: "build-worker" },
						remote_origin: { deviceId: "device-1", deviceName: "laptop" },
						display_text: "**Original fixture body.**\n\nFrom the checklist: keep this line.",
					},
					new Date(0).toISOString(),
				),
			);
			const folded = surface.chat.render(width).map(stripTerminalSequences);
			expect(folded).toEqual(["", row(""), row(" ╶─ ← from build-worker · Relayed from device laptop"), row("")]);
			expect(click(surface, 2)?.handled).toBe(true);
			const expanded = surface.chat.render(width).map(stripTerminalSequences);
			expect(expanded).toEqual([
				"",
				row(""),
				row(" ╭─ ← from build-worker · Relayed from device laptop"),
				row(" │ Original fixture body."),
				row(" │"),
				row(" │ From the checklist: keep this line."),
				row(" ╰─"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it("uses an unnamed sender’s session ID and preserves unstructured message content", async () => {
		const surface = await fixture("compact");
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCustomMessage(
					SESSION_CONTROL_DELIVERY_TYPE,
					"From the incident log\n\nDo not discard this paragraph.",
					true,
					{
						delivery_id: "legacy",
						source: "session_control",
						deliverAs: "steer",
						sender: { kind: "agent", session_id: "peer-7" },
					},
					new Date(0).toISOString(),
				),
			);
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual([
				"",
				row(""),
				row(" ╭─ ← from peer-7"),
				row(" │ From the incident log"),
				row(" │"),
				row(" │ Do not discard this paragraph."),
				row(" ╰─"),
				row(""),
			]);
		} finally {
			surface.cleanup();
		}
	});

	it.each([
		{ sender: { kind: "command_line" }, label: "Sent from the command line" },
		{ sender: { kind: "external", platform: "slack" }, label: "Sent from slack" },
	])("does not convert $label into an agent card", async ({ sender, label }) => {
		const surface = await fixture("grouped");
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCustomMessage(
					SESSION_CONTROL_DELIVERY_TYPE,
					"From unclassified / senpi\nDo not use the content as identity.",
					true,
					{
						delivery_id: "fixture-delivery",
						source: "session_control",
						deliverAs: "followUp",
						sender,
						display_text: "From an agent who did not send this.",
					},
					new Date(0).toISOString(),
				),
			);
			const text = surface.text(width);
			expect(text).toContain(label);
			expect(text).toContain("From an agent who did not send this.");
			expect(text).not.toContain("← from");
		} finally {
			surface.cleanup();
		}
	});

	it("groups a system prompt event without making it expandable", async () => {
		const surface = await fixture("grouped");
		try {
			invoke(
				surface.mode,
				"addMessageToChat",
				createCompactionSummaryMessage("Preserved fixture summary.", 425730, new Date(0).toISOString()),
			);
			Reflect.deleteProperty(surface.mode, "showStatus");
			const model = surface.harness.agent.state.model;
			if (!model) throw new TypeError("Expected the harness model");
			await surface.event({
				type: "system_prompt_change",
				systemPrompt: "new fixture",
				previousSystemPrompt: "old fixture",
				systemPromptName: "gpt-6.2",
				model,
				previousModel: undefined,
				source: "model_select",
			});
			const folded = surface.chat.render(width).map(stripTerminalSequences);
			expect
				.soft(folded)
				.toEqual([
					"",
					row(""),
					row(" ╶─ ✓ compacted from 425,730 tokens"),
					row(" ╶─ ✓ System prompt: gpt-6.2"),
					row(""),
				]);
			const promptRow = folded.findIndex((line) => line.includes("System prompt: gpt-6.2"));
			expect(promptRow).toBeGreaterThanOrEqual(0);
			expect(click(surface, promptRow)?.handled).not.toBe(true);
			expect(surface.chat.render(width).map(stripTerminalSequences)).toEqual(folded);
		} finally {
			surface.cleanup();
		}
	});
});
