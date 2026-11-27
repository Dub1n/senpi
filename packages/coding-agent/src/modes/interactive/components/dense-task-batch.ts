import { type DensityCardRenderOptions, nextRenderRevision } from "@earendil-works/pi-tui";
import type { DensityFolds } from "./density-fold.ts";
import { densityNestView, DensityRunFold } from "./density-nest.ts";
import type { OmoTaskDensityProjection } from "./omo-task-density.ts";
import type { DensityCardSource } from "./tool-density-row.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type TaskBatch = Extract<OmoTaskDensityProjection, { type: "members" }>;

/** A batch shares its invocation's outer fold, but each worker owns its detail fold. */
export class DenseTaskBatch implements DensityCardSource {
	readonly densityGroup = true;
	private readonly folds: DensityRunFold;
	private readonly owner: ToolExecutionComponent;
	private readonly preferences: DensityFolds;
	private batch: TaskBatch;
	private revision = nextRenderRevision();

	constructor(owner: ToolExecutionComponent, preferences: DensityFolds, batch: TaskBatch) {
		this.owner = owner;
		this.preferences = preferences;
		this.folds = new DensityRunFold(preferences.forTool(owner.toolCallId));
		this.batch = batch;
		this.setBatch(batch);
	}

	setBatch(batch: TaskBatch): void {
		this.batch = batch;
		this.folds.join(batch.members.map((_, index) => this.preferences.forTaskWorker(this.owner.toolCallId, index)));
		this.revision = nextRenderRevision();
	}

	get densityExpanded(): boolean {
		return this.folds.open("task", this.owner.summarySnapshot.expanded);
	}

	setExpanded(expanded: boolean): void {
		this.folds.set(expanded);
	}

	toggleDensityMember(index: number): void {
		this.folds.toggleMember(index, "task");
	}

	renderDensityCard(_width: number, { expanded }: DensityCardRenderOptions) {
		const [first, ...rest] = this.batch.members;
		return expanded && first
			? densityNestView(first, rest, (index) => this.folds.memberOpen(index, "task"))
			: this.batch.summary;
	}

	renderDensitySummary(): string[] {
		return [];
	}

	render(): string[] {
		return [];
	}

	getBackgroundPainter(): ReturnType<ToolExecutionComponent["getBackgroundPainter"]> {
		return this.owner.getBackgroundPainter();
	}

	getRenderRevision(): number {
		return Math.max(this.revision, this.folds.revision, this.owner.getRenderRevision() ?? 0);
	}

	invalidate(): void {
		this.revision = nextRenderRevision();
	}
}
