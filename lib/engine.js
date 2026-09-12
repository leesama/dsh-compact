/**
 * dsh-compact — compaction telemetry & shadow-cost reporting for DeepSeek Harness.
 *
 * Pure accounting over the compaction/* session-event stream:
 *
 *   compaction/start    { turn }
 *   compaction/summary  { summary, shadowedRange, shadowedSeqs,
 *                         shadowedTokenCount, provider, model, usage? }
 *   compaction/end      { turn, error? }
 *
 * Produces per-compaction records, cumulative totals, and a text report
 * exposed via the /compact-stats command.
 */
export function emptyState() {
    return { records: [] };
}
export function restoreState(data) {
    if (!data || typeof data !== "object")
        return emptyState();
    const records = data.records;
    if (!Array.isArray(records))
        return emptyState();
    const valid = records.filter(isCompactionRecord);
    return { records: valid };
}
function isCompactionRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return (typeof record.time === "string" &&
        typeof record.shadowedTokens === "number" &&
        typeof record.summaryChars === "number");
}
const MAX_RECORDS = 200;
export function appendRecord(state, record) {
    state.records.push(record);
    if (state.records.length > MAX_RECORDS) {
        state.records.splice(0, state.records.length - MAX_RECORDS);
    }
}
export function usageTokens(usage) {
    if (!usage)
        return 0;
    return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}
export function computeTotals(state) {
    const totals = {
        compactions: 0,
        failures: 0,
        shadowedTokens: 0,
        summaryTokens: 0,
        summaryCostTokens: 0,
    };
    for (const record of state.records) {
        if (record.error) {
            totals.failures += 1;
            continue;
        }
        totals.compactions += 1;
        totals.shadowedTokens += record.shadowedTokens;
        totals.summaryTokens += record.summaryTokens;
        totals.summaryCostTokens += usageTokens(record.usage);
    }
    return totals;
}
/** Net context reduction: shadowed tokens minus the summary that replaced them. */
export function netReduction(record) {
    return record.shadowedTokens - record.summaryTokens;
}
/**
 * Fold one session event into the state. The reducer is tolerant: unknown
 * event types are ignored, and a summary/end without a matching start is
 * still recorded with best-effort defaults (clock from the fold caller).
 */
export function foldEvent(state, open, event, now) {
    if (event.type === "compaction/start") {
        return { turn: event.data?.turn ?? null, startedAt: now().toISOString(), summary: undefined };
    }
    if (event.type === "compaction/summary") {
        const summary = event.data;
        if (open) {
            open.summary = summary;
            return open;
        }
        // summary without start (crash recovery): record immediately.
        appendRecord(state, recordFrom(now().toISOString(), null, summary, undefined));
        return undefined;
    }
    if (event.type === "compaction/end") {
        const end = event.data ?? {};
        if (open) {
            appendRecord(state, recordFrom(open.startedAt, open.turn, open.summary, end.error));
        }
        else if (end.error) {
            appendRecord(state, {
                time: now().toISOString(),
                turn: end.turn ?? null,
                shadowedTokens: 0,
                summaryChars: 0,
                summaryTokens: 0,
                shadowedSeqs: 0,
                error: end.error,
            });
        }
        return undefined;
    }
    return open;
}
function recordFrom(time, turn, summary, error) {
    return {
        time,
        turn,
        provider: summary?.provider,
        model: summary?.model,
        shadowedTokens: summary?.shadowedTokenCount ?? 0,
        summaryChars: summary?.summary?.length ?? 0,
        summaryTokens: estimateTokens(summary?.summary ?? ""),
        usage: summary?.usage,
        shadowedSeqs: summary?.shadowedSeqs?.length ?? 0,
        error,
    };
}
/** Rough token estimate for summary text: chars/4 rounded up. */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
// ---------------------------------------------------------------------------
// Report rendering — pure.
// ---------------------------------------------------------------------------
function pad(value, width) {
    return value.length >= width ? value : `${value} `;
}
export function formatStatsReport(state, limit = 10) {
    if (state.records.length === 0) {
        return "dsh-compact: no compactions recorded in this session yet.";
    }
    const totals = computeTotals(state);
    const lines = [];
    lines.push(`dsh-compact — ${totals.compactions} compaction(s), ${totals.failures} failure(s)`);
    const net = totals.shadowedTokens - totals.summaryTokens;
    lines.push(`shadowed ${totals.shadowedTokens.toLocaleString()} tok · summaries ~${totals.summaryTokens.toLocaleString()} tok · net −${net.toLocaleString()} tok on the surface`);
    if (totals.summaryCostTokens > 0) {
        lines.push(`summary LLM cost: ${totals.summaryCostTokens.toLocaleString()} tok across calls`);
    }
    lines.push("");
    lines.push(`${pad("time", 21)}${pad("turn", 7)}${pad("shadowed", 11)}${pad("summary", 10)}model`);
    const recent = state.records.slice(-limit).reverse();
    for (const record of recent) {
        const time = record.time.slice(11, 19);
        const turn = record.turn === null ? "-" : String(record.turn);
        const shadowed = record.error ? "-" : record.shadowedTokens.toLocaleString();
        const summary = record.error ? `FAILED` : `~${record.summaryTokens.toLocaleString()}`;
        const model = record.model ?? record.provider ?? "unknown";
        const suffix = record.error ? ` (${record.error})` : "";
        lines.push(`${pad(time, 21)}${pad(turn, 7)}${pad(shadowed, 11)}${pad(summary, 10)}${model}${suffix}`);
    }
    return lines.join("\n");
}
