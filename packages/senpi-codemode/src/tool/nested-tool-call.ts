import { sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import {
	capCodePoints,
	toolCallResultDetails,
	toolCallResultPreview,
	toolCallResultTestSummary,
} from "./call-capture.ts";
import type { CellResultBuilder } from "./cell-runtime.ts";
import { marshalToolResult, toolResultIsError } from "./image.ts";
import type { EvalTestSummary } from "./types.ts";

export type ResolvedToolReply = {
	readonly value: unknown;
	readonly toolCallOk: boolean;
	readonly resultPreview?: string;
	readonly errorText?: string;
	readonly testSummary?: EvalTestSummary;
	/** The result's details, kept only for a tool whose own renderResult draws its nested row. */
	readonly details?: unknown;
};

/** Runs an ordinary host tool for a JS cell; its partial results stream into the cell's live update (#6167). */
export async function runNestedTool(
	executeTool: AgentExecuteTool,
	message: Extract<KernelToHostMessage, { type: "tool-call" }>,
	signal: AbortSignal,
	live: CellResultBuilder,
	keepDetails = false,
): Promise<ResolvedToolReply> {
	const result = await executeTool(message.toolName, message.args, {
		signal,
		onUpdate: (partial) => live.nestedToolUpdate(message.callId, partial),
	}).finally(() => live.dropNestedTool(message.callId));
	const toolCallOk = !toolResultIsError(result);
	const testSummary = toolCallResultTestSummary(result);
	const details = keepDetails ? toolCallResultDetails(result) : undefined;
	const kept = details === undefined ? {} : { details };
	const capturedTestSummary = testSummary === undefined ? {} : { testSummary };
	if (toolCallOk) {
		const resultPreview = toolCallResultPreview(result);
		return {
			value: marshalToolResult(result),
			toolCallOk,
			...(resultPreview === undefined ? {} : { resultPreview }),
			...capturedTestSummary,
			...kept,
		};
	}
	let errorText: string | undefined;
	for (const part of result.content) {
		if (part.type !== "text") continue;
		errorText = capCodePoints(sanitizeTerminalLabel(part.text), 512);
		break;
	}
	return {
		value: marshalToolResult(result),
		toolCallOk,
		...(errorText === undefined ? {} : { errorText }),
		...capturedTestSummary,
		...kept,
	};
}
