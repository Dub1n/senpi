import path from "node:path";
import { sanitizeTerminalLabel, wrapTextWithAnsi, type DensityCardStructuredView } from "@earendil-works/pi-tui";
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

export function patchDensityCard(input: DensityInput): DensityCardStructuredView {
	const { result, isError, isPartial, executionStarted, cwd, theme } = input;
	const settled = result?.details?.result;
	const failed = isError || (settled?.failures.length ?? 0) > 0;
	// Pending previews are speculative; only result previews describe operations actually applied.
	const files = settled ? (result?.details?.preview?.files ?? []) : [];
	const successful = settled !== undefined && !failed && !isPartial;
	const single = successful && files.length === 1 ? files[0] : undefined;
	const allSameOperation = files.every((file) => file.operation === files[0]?.operation);
	const kind = single
		? operation(single)
		: successful && files.length >= 3
			? allSameOperation
				? operation(files[0])
				: "patched"
			: "tool";
	const details = single
		? [summary(single)]
		: successful && files.length > 0
			? [`${files.length} files`]
			: failed
				? ["failed"]
				: [];
	const heading = {
		identity: single
			? filePath(single, cwd, true)
			: successful && files.length >= 3
				? files.map((file) => path.basename(file.movePath ?? file.filePath)).join(" ")
				: "apply_patch",
		details: single ? details : successful && files.length >= 3 ? [] : details,
	};
	const expandedHeading = single
		? { identity: filePath(single, cwd, false), identitySuffix: `:${summary(single)}` }
		: heading;
	const status = failed ? "failed" : isPartial || !settled ? (executionStarted ? "running" : "pending") : "done";
	const renderFile = (file: ApplyPatchPreviewFile, width: number) =>
		file.diff
			? wrapTextWithAnsi(
					renderToolDiff(truncatePreview(file.diff), {
						filePath: file.movePath ?? file.filePath,
						theme,
						contextContentColor: "muted",
					}),
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
	const progress = !settled && result?.details?.progress;
	return {
		format: "structured",
		kind,
		heading,
		expandedHeading,
		status,
		body: [
			...(single ? [{ type: "rich" as const, render: (width: number) => renderFile(single, width) }] : []),
			...(progress
				? [{ type: "text" as const, lines: [`progress: ${progress.applied + progress.failed}/${progress.total}`] }]
				: []),
			...(diagnosticText ? [{ type: "text" as const, lines: diagnosticText.split("\n") }] : []),
		],
		sections: single
			? []
			: files.map((file) => ({
					placement: "frame" as const,
					heading: {
						kind: operation(file),
						heading: { identity: filePath(file, cwd, false), identitySuffix: `:${summary(file)}` },
						status: "done" as const,
					},
					body: [{ type: "rich" as const, render: (width: number) => renderFile(file, width) }],
				})),
	};
}
