import path from "node:path";
import { sanitizeTerminalLabel, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "../../types.ts";
import { renderToolDiff } from "../../../tools/diff-render.ts";
import { truncatePreview } from "./preview-format.ts";
import type { ApplyPatchPreviewFile, ApplyPatchTheme, ApplyPatchToolDetails } from "./types.ts";

type DensityInput = {
	readonly result?: AgentToolResult<ApplyPatchToolDetails | undefined>;
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly executionStarted: boolean;
	readonly cwd: string;
	readonly theme: ApplyPatchTheme;
};

function filePath(file: ApplyPatchPreviewFile, cwd: string, short: boolean): string {
	const label = (value: string) => sanitizeTerminalLabel(short ? path.basename(value) : path.resolve(cwd, value));
	return file.movePath ? `${label(file.filePath)} → ${label(file.movePath)}` : label(file.filePath);
}

function summary(file: ApplyPatchPreviewFile): string {
	return file.binary ? "(binary)" : `(+${file.added} -${file.removed})`;
}

function operation(file: ApplyPatchPreviewFile): "added" | "edited" | "deleted" {
	switch (file.operation) {
		case "add":
			return "added";
		case "delete":
			return "deleted";
		case "update":
			return "edited";
	}
}

export function patchDensityCard(input: DensityInput) {
	const { result, isError, isPartial, executionStarted, cwd, theme } = input;
	const settled = result?.details?.result;
	const failed = isError || (settled?.failures.length ?? 0) > 0;
	// Pending previews are speculative; only result previews describe operations actually applied.
	const files = settled ? (result?.details?.preview?.files ?? []) : [];
	const successful = settled !== undefined && !failed && !isPartial;
	const single = successful && files.length === 1 ? files[0] : undefined;
	const name = single ? operation(single) : "tool";
	const title = single
		? ` ${filePath(single, cwd, true)} ${summary(single)}`
		: successful && files.length > 0
			? ` apply_patch ${files.length} files`
			: failed
				? " apply_patch failed"
				: " apply_patch";
	const expandedTitle = single ? ` ${filePath(single, cwd, false)} ${summary(single)}` : title;
	const status = failed ? "failed" : isPartial || !settled ? (executionStarted ? "running" : "pending") : "done";
	const renderFile = (file: ApplyPatchPreviewFile, width: number) =>
		file.diff
			? wrapTextWithAnsi(
					renderToolDiff(truncatePreview(file.diff), { filePath: file.movePath ?? file.filePath, theme }),
					width,
				)
			: [];
	const diagnosticText =
		failed || !successful
			? (result?.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n") ?? "")
			: "";
	return {
		name,
		kind: single ? name : ("tool" as const),
		title,
		expandedTitle,
		status,
		renderContent: (width: number) => {
			const lines = single ? renderFile(single, width) : [];
			const progress = !settled && result?.details?.progress;
			if (progress) lines.push(`progress: ${progress.applied + progress.failed}/${progress.total}`);
			return diagnosticText ? [...lines, ...wrapTextWithAnsi(diagnosticText, width)] : lines;
		},
		sections: single
			? []
			: files.map((file) => ({
					label: `${operation(file)} ${filePath(file, cwd, false)} ${summary(file)}`,
					placement: "frame" as const,
					render: (width: number) => renderFile(file, width),
				})),
	};
}
