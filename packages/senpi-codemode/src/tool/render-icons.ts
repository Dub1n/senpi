import type { DensityCardStatus } from "@code-yeongyu/senpi";
import type { EvalCellResult } from "./types.ts";

export type EvalIconResolver = (status: DensityCardStatus) => string | undefined;

const cellHeadingStatus = {
	pending: "pending",
	queued: "queued",
	running: "running",
	detached: "detached",
	complete: "done",
	error: "failed",
	cancelled: "cancelled",
} as const satisfies Record<EvalCellResult["status"], DensityCardStatus>;

export function evalHeadingIcon(resolver: EvalIconResolver | undefined, status: DensityCardStatus): string | undefined {
	// A configured Eval icon can identify the live tool, but must not hide a failure, cancellation, or detach.
	return (
		resolver?.(status) ??
		(status === "pending" || status === "queued" || status === "running" ? resolver?.("done") : undefined)
	);
}

export function cellHeadingIcon(
	resolver: EvalIconResolver | undefined,
	status: EvalCellResult["status"],
	fallback: string,
): string {
	return evalHeadingIcon(resolver, cellHeadingStatus[status]) ?? fallback;
}

export function prefixEvalHeading(title: string, icon: string | undefined): string {
	return icon === undefined ? title : `${icon} ${title}`;
}
