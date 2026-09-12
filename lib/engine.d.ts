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
export interface CompactionUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
}
export interface CompactionRecord {
    /** ISO timestamp of compaction/end (or start when still open). */
    time: string;
    turn: number | null;
    provider?: string;
    model?: string;
    /** Tokens removed from the surface (shadowed). */
    shadowedTokens: number;
    /** Character length of the summary text. */
    summaryChars: number;
    summaryTokens: number;
    /** Token usage of the summary LLM call, when reported. */
    usage?: CompactionUsage;
    /** Number of seqs replaced. */
    shadowedSeqs: number;
    error?: string;
}
export interface CompactionState {
    records: CompactionRecord[];
}
export declare function emptyState(): CompactionState;
export declare function restoreState(data: unknown): CompactionState;
export declare function appendRecord(state: CompactionState, record: CompactionRecord): void;
export declare function usageTokens(usage: CompactionUsage | undefined): number;
export interface CompactionTotals {
    compactions: number;
    failures: number;
    shadowedTokens: number;
    summaryTokens: number;
    summaryCostTokens: number;
}
export declare function computeTotals(state: CompactionState): CompactionTotals;
/** Net context reduction: shadowed tokens minus the summary that replaced them. */
export declare function netReduction(record: CompactionRecord): number;
export interface CompactionStartPayload {
    turn: number | null;
}
export interface CompactionSummaryPayload {
    summary: string;
    shadowedTokenCount: number;
    shadowedSeqs?: readonly number[];
    provider?: string;
    model?: string;
    usage?: CompactionUsage;
}
export interface CompactionEndPayload {
    turn: number | null;
    error?: string;
}
export interface OpenCompaction {
    turn: number | null;
    startedAt: string;
    summary?: CompactionSummaryPayload;
}
/**
 * Fold one session event into the state. The reducer is tolerant: unknown
 * event types are ignored, and a summary/end without a matching start is
 * still recorded with best-effort defaults (clock from the fold caller).
 */
export declare function foldEvent(state: CompactionState, open: OpenCompaction | undefined, event: {
    type: string;
    data: unknown;
}, now: () => Date): OpenCompaction | undefined;
/** Rough token estimate for summary text: chars/4 rounded up. */
export declare function estimateTokens(text: string): number;
export declare function formatStatsReport(state: CompactionState, limit?: number): string;
