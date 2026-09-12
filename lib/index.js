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
import { emptyState, foldEvent, formatStatsReport, restoreState, } from "./engine";
export const Config = Schema.object({
    reportRows: Schema.number().default(10),
    persist: Schema.boolean().default(true),
});
export const name = "dsh-compact";
export const inject = ["commands"];
export function apply(ctx, config, store = noopStore) {
    let state = store.load() ?? emptyState();
    let open;
    function persist() {
        if (config.persist)
            store.save(state);
    }
    const handles = {
        handleEvent(event) {
            open = foldEvent(state, open, event, () => new Date());
            if (event.type.startsWith("compaction/"))
                persist();
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
const noopStore = { load: () => undefined, save: () => undefined };
/** Restore plugin state from persisted data (used on session resume). */
export function restore(data) {
    return restoreState(data);
}
