/**
 * dsh-compact — compaction telemetry & shadow-cost reporting for DeepSeek Harness.
 *
 * Listens to the `session/event` firehose for the compaction/* lifecycle and
 * exposes the accounting via the /compact-stats command:
 *
 *   compaction/start    → open a record
 *   compaction/summary  → attach shadowed tokens / summary / usage / model
 *   compaction/end      → close the record (error? → failure)
 *
 * Persistence is pluggable: the plugin calls the injected `store` on every
 * mutation (the Cordis layer wires it to ctx.storageDomain); a no-op store
 * keeps the plugin fully functional in-memory.
 */

import Schema from "@deepseek-ai/schemastery";
import {
	type CompactionRecord,
	type CompactionState,
	emptyState,
	foldEvent,
	formatStatsReport,
	type OpenCompaction,
	restoreState,
} from "./engine";

export interface Config {
	/** Number of records shown in the /compact-stats table. Default 10. */
	reportRows: number;
	/** Persist records to the injected store. Default true. */
	persist: boolean;
}

export const Config: Schema<Config> = Schema.object({
	reportRows: Schema.number().default(10),
	persist: Schema.boolean().default(true),
});

export const name = "dsh-compact";
export const inject = ["commands"];

/** Minimal persistence contract; the Cordis layer adapts it to storageDomain. */
export interface CompactionStore {
	/** Load persisted state on boot; return undefined to start fresh. */
	load(): CompactionState | undefined;
	save(state: CompactionState): void;
}

interface SessionEventLike {
	type: string;
	data: unknown;
}

interface DshContext {
	on(event: "session/event", handler: (session: unknown, event: SessionEventLike) => void): () => void;
	commands: {
		register(definition: {
			name: string;
			description: string;
			handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text?: string }>;
		}): () => void;
	};
}

export interface PluginHandles {
	/** Feed one session event through the plugin (also called by the e2e harness). */
	handleEvent(event: SessionEventLike): void;
	/** Current report text. */
	report(): string;
	/** Current records (defensive copy). */
	records(): CompactionRecord[];
}

export function apply(ctx: DshContext, config: Config, store: CompactionStore = noopStore): PluginHandles {
	let state: CompactionState = store.load() ?? emptyState();
	let open: OpenCompaction | undefined;

	function persist(): void {
		if (config.persist) store.save(state);
	}

	const handles: PluginHandles = {
		handleEvent(event) {
			open = foldEvent(state, open, event, () => new Date());
			if (event.type.startsWith("compaction/")) persist();
		},
		report() {
			return formatStatsReport(state, config.reportRows);
		},
		records() {
			return state.records.map((record) => ({ ...record }));
		},
	};

	ctx.on("session/event", (_session, event) => {
		handles.handleEvent(event);
	});

	ctx.commands.register({
		name: "compact-stats",
		description: "Show dsh-compact compaction history and shadow-token savings",
		handler: async () => {
			return { kind: "success", text: handles.report() };
		},
	});

	return handles;
}

const noopStore: CompactionStore = { load: () => undefined, save: () => undefined };

/** Restore plugin state from persisted data (used on session resume). */
export function restore(data: unknown): CompactionState {
	return restoreState(data);
}
