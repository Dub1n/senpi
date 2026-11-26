import { describe, expect, it } from "vitest";
import {
	createToolCallMetric,
	recordToolCall,
	toolCallResultDetails,
	toolCallResultTestSummary,
} from "../src/tool/call-capture.ts";
import type { EvalToolCallSummary } from "../src/tool/types.ts";

// A nested call's details ride on its summary (persisted with the eval result) only so the tool's own renderResult can
// draw the row (oh-my-openagent#12994); the copy is plain JSON and bounded, never the live object.
describe("nested call details", () => {
	it("keeps a JSON copy of a tool result's details on the enriched summary", () => {
		const toolCalls: EvalToolCallSummary[] = [];
		const details = toolCallResultDetails({ content: [], details: { result: { kind: "ok", threads: [] } } });
		recordToolCall(toolCalls, {
			ok: true,
			capture: {
				metric: createToolCallMetric("thread_list", 0),
				startedAt: 0,
				includeDetails: true,
				callId: "c-1",
				args: {},
			},
			details,
		});

		expect(toolCalls[0]?.details).toEqual({ result: { kind: "ok", threads: [] } });
	});

	it("drops details that are too large or not JSON", () => {
		expect(toolCallResultDetails({ content: [], details: { blob: "x".repeat(20_000) } })).toBeUndefined();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(toolCallResultDetails({ content: [], details: cyclic })).toBeUndefined();
		expect(toolCallResultDetails({ content: [], details: undefined })).toBeUndefined();
	});

	it("keeps bounded test counts on the matching tool call without treating failures as tool errors", () => {
		const toolCalls: EvalToolCallSummary[] = [];
		const testSummary = toolCallResultTestSummary({
			content: [],
			details: {
				testSummary: {
					version: 1,
					runner: `\u001b[31m${"v".repeat(200)}\u001b[0m`,
					passed: 4,
					failed: 2,
					skipped: 1,
					unused: "not copied",
				},
			},
		});

		recordToolCall(toolCalls, {
			ok: true,
			capture: {
				metric: createToolCallMetric("bash", 0),
				startedAt: 0,
				includeDetails: true,
				callId: "bash-1",
				args: { command: "bun test" },
			},
			resultPreview: "raw command output",
			...(testSummary === undefined ? {} : { testSummary }),
		});

		expect(toolCalls[0]?.ok).toBe(true);
		expect(toolCalls[0]?.testSummary).toEqual({
			version: 1,
			runner: `${"v".repeat(128)}…`,
			passed: 4,
			failed: 2,
			skipped: 1,
		});
		expect(toolCalls[0]?.resultPreview).toBe("raw command output");
	});

	it.each([
		{ label: "null", testSummary: null },
		{
			label: "unsupported version",
			testSummary: { version: 2, runner: "version-two", passed: 1, failed: 0, skipped: 0 },
		},
		{ label: "all-zero counts", testSummary: { version: 1, runner: "empty", passed: 0, failed: 0, skipped: 0 } },
		{ label: "negative count", testSummary: { version: 1, runner: "vitest", passed: 1, failed: -1, skipped: 0 } },
	])("ignores malformed host test summaries: $label", ({ testSummary }) => {
		expect(toolCallResultTestSummary({ content: [], details: { testSummary } })).toBeUndefined();
	});
});
