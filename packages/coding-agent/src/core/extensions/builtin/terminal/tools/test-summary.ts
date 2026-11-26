/** Presentation metadata carried by terminal tool results, independent of runner reports. */
export interface TestSummary {
	readonly version: 1;
	readonly runner: string;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate metadata at the transcript and child transport boundaries. */
export function readTestSummary(value: unknown): TestSummary | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { version, runner, passed, failed, skipped } = value as Record<string, unknown>;
	if (
		version !== 1 ||
		typeof runner !== "string" ||
		!/^[a-z][a-z0-9-]{0,31}$/.test(runner) ||
		!count(passed) ||
		!count(failed) ||
		!count(skipped) ||
		!Number.isSafeInteger(passed + failed + skipped) ||
		passed + failed + skipped === 0
	) {
		return undefined;
	}
	return { version, runner, passed, failed, skipped };
}

/** Keep the important nonzero failure count first, including in narrow cards. */
export function testSummaryLabel(value: unknown): string | undefined {
	const summary = readTestSummary(value);
	if (summary === undefined) return undefined;
	return formatTestSummary(summary);
}

/** Format validated counts for a dense heading. */
export function formatTestSummary(summary: TestSummary): string {
	const { passed, failed, skipped } = summary;
	return [
		...(failed > 0 ? [`${failed} failed`] : []),
		...(passed > 0 || failed > 0 ? [`${passed} passed`] : []),
		...(skipped > 0 ? [`${skipped} skipped`] : []),
	].join(", ");
}
