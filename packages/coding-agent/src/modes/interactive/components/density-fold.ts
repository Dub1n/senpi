import { nextRenderRevision } from "@earendil-works/pi-tui";

/** Session-local presentation state, independent of renderer expansion and result content. */
export class DensityFold {
	choice: boolean | undefined;
	revision = 0;
	private initialLiveOpen: boolean | undefined;
	private reveal = false;

	set(expanded: boolean): void {
		this.choice = expanded;
		this.revision = nextRenderRevision();
	}

	setToolChoice(expanded: boolean, pending: boolean): void {
		if (pending) {
			this.initialLiveOpen ??= !expanded;
			this.reveal = expanded;
		} else {
			this.reveal = false;
		}
		this.set(expanded);
	}

	get patchChoice(): boolean | undefined {
		// A standalone row preserves a refold; a file joining its own projection
		// falls back to its own default if the running row started out folded.
		return this.initialLiveOpen === false && this.choice === false ? undefined : this.choice;
	}

	takeReveal(): boolean {
		const reveal = this.reveal;
		this.reveal = false;
		return reveal;
	}

	reset(): void {
		this.choice = undefined;
		this.initialLiveOpen = undefined;
		this.reveal = false;
		this.revision = nextRenderRevision();
	}
}

/** Only fold intent outlives a reconstruction, never a row, renderer, or result. */
export class DensityFolds {
	private readonly byKey = new Map<string, DensityFold>();

	forTool(id: string): DensityFold {
		return this.get(JSON.stringify(["tool", id]));
	}

	forPatch(id: string, type: "file" | "failure" | "group", occurrence?: string): DensityFold {
		return this.get(JSON.stringify([type, id, occurrence]));
	}

	reset(): void {
		for (const fold of this.byKey.values()) {
			if (fold.choice !== undefined) fold.reset();
		}
	}

	private get(key: string): DensityFold {
		let fold = this.byKey.get(key);
		if (!fold) {
			fold = new DensityFold();
			this.byKey.set(key, fold);
		}
		return fold;
	}
}
