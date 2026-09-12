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
import { type CompactionRecord, type CompactionState } from "./engine";
export interface Config {
    /** Number of records shown in the /compact-stats table. Default 10. */
    reportRows: number;
    /** Persist records to the injected store. Default true. */
    persist: boolean;
}
export declare const Config: Schema<Config>;
export declare const name = "dsh-compact";
export declare const inject: string[];
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
            handler: (invocation: {
                rawInput?: string;
            }) => Promise<{
                kind: string;
                text?: string;
            }>;
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
export declare function apply(ctx: DshContext, config: Config, store?: CompactionStore): PluginHandles;
/** Restore plugin state from persisted data (used on session resume). */
export declare function restore(data: unknown): CompactionState;
export {};
