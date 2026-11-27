import { type Component, type DensityCardKind, nextRenderRevision } from "@earendil-works/pi-tui";
import type { ToolCardFoldDefaults, ToolCardNesting } from "../../../core/settings-manager.ts";
import { densityCardFoldName } from "./density-card-style.ts";

/** Session-local presentation state, independent of renderer expansion and result content. */
export class DensityFold {
	private manualChoice: boolean | undefined;
	revision = 0;
	private initialLiveOpen: boolean | undefined;
	private reveal = false;
	private namedDefault: { readonly kind: DensityCardKind; readonly open: boolean | undefined } | undefined;
	private readonly initialDefaults: ToolCardFoldDefaults;
	private readonly createdAtEpoch: number;
	private resetEpoch = 0;
	private readonly preferences: DensityFolds;

	constructor(preferences: DensityFolds) {
		this.preferences = preferences;
		this.initialDefaults = preferences.defaults;
		this.createdAtEpoch = this.resetEpoch = preferences.resetEpoch;
	}

	get choice(): boolean | undefined {
		return this.resetEpoch === this.preferences.resetEpoch ? this.manualChoice : undefined;
	}

	defaultOpen(kind: DensityCardKind, fallback: boolean, nest = false): boolean {
		if (this.namedDefault?.kind !== kind) {
			const defaults = this.namedDefault ? this.preferences.defaults : this.initialDefaults;
			const value = defaults[densityCardFoldName(kind)];
			const open = value === undefined ? undefined : value === "unfolded";
			if (nest && this.namedDefault && this.choice === false) this.manualChoice = undefined;
			this.namedDefault = { kind, open };
		}
		const global = this.createdAtEpoch !== this.preferences.resetEpoch ? this.preferences.globalExpansion : undefined;
		return global ?? this.namedDefault.open ?? fallback;
	}

	nestOpen(kind: DensityCardKind, fallback: boolean): boolean {
		const defaultOpen = this.defaultOpen(kind, fallback, true);
		return this.choice ?? defaultOpen;
	}

	set(expanded: boolean): void {
		this.initialLiveOpen = undefined;
		this.reveal = false;
		this.writeChoice(expanded);
	}

	private writeChoice(expanded: boolean): void {
		this.resetEpoch = this.preferences.resetEpoch;
		this.manualChoice = expanded;
		this.revision = nextRenderRevision();
	}

	setToolChoice(expanded: boolean, pending: boolean): void {
		if (pending) {
			if (this.resetEpoch !== this.preferences.resetEpoch) this.initialLiveOpen = undefined;
			this.initialLiveOpen ??= !expanded;
			this.reveal = expanded;
		} else {
			this.initialLiveOpen = undefined;
			this.reveal = false;
		}
		this.writeChoice(expanded);
	}

	get memberChoice(): boolean | undefined {
		// The standalone row preserves a refold, but a member that started
		// folded and was refolded before joining uses its nest member default.
		return this.initialLiveOpen === false && this.choice === false ? undefined : this.choice;
	}

	takeReveal(): boolean {
		const reveal = this.resetEpoch === this.preferences.resetEpoch && this.reveal;
		this.reveal = false;
		return reveal;
	}
}

/** Only fold intent outlives a reconstruction, never a row, renderer, or result. */
export class DensityFolds {
	private readonly byKey = new Map<string, DensityFold>();
	private readonly bySource = new WeakMap<Component, DensityFold>();
	defaults: ToolCardFoldDefaults = {};
	globalExpansion: boolean | undefined;
	resetEpoch = 0;

	setDefaults(defaults: ToolCardFoldDefaults): void {
		this.defaults = defaults;
	}

	forTool(id: string): DensityFold {
		return this.get(JSON.stringify(["tool", id]));
	}

	forTaskWorker(id: string, index: number): DensityFold {
		return this.get(JSON.stringify(["task-worker", id, index]));
	}

	forEntry(id: string): DensityFold {
		return this.get(JSON.stringify(["entry", id]));
	}

	forSource(source: Component, nest = false): DensityFold {
		if (nest) return this.forSourceNest(source);
		let fold = this.bySource.get(source);
		if (!fold) {
			fold = new DensityFold(this);
			this.bySource.set(source, fold);
		}
		return fold;
	}

	private readonly sourceNests = new WeakMap<Component, DensityFold>();

	private forSourceNest(source: Component): DensityFold {
		let fold = this.sourceNests.get(source);
		if (!fold) {
			fold = new DensityFold(this);
			this.sourceNests.set(source, fold);
		}
		return fold;
	}

	forNest(family: keyof ToolCardNesting, anchor: string): DensityFold {
		return this.get(JSON.stringify(["nest", family, anchor]));
	}

	forPatch(id: string, type: "file" | "failure" | "group", occurrence?: number): DensityFold {
		return this.get(JSON.stringify([type, id, occurrence]));
	}

	reset(expanded: boolean): void {
		this.globalExpansion = expanded;
		this.resetEpoch++;
	}

	private get(key: string): DensityFold {
		let fold = this.byKey.get(key);
		if (!fold) {
			fold = new DensityFold(this);
			this.byKey.set(key, fold);
		}
		return fold;
	}
}
