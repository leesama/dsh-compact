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

export function emptyState(): CompactionState {
	return { records: [] };
}

export function restoreState(data: unknown): CompactionState {
	if (!data || typeof data !== "object") return emptyState();
	const records = (data as { records?: unknown }).records;
	if (!Array.isArray(records)) return emptyState();
	const valid = records.filter(isCompactionRecord);
	return { records: valid };
}

function isCompactionRecord(value: unknown): value is CompactionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.time === "string" &&
		typeof record.shadowedTokens === "number" &&
		typeof record.summaryChars === "number"
	);
}

const MAX_RECORDS = 200;

export function appendRecord(state: CompactionState, record: CompactionRecord): void {
	state.records.push(record);
	if (state.records.length > MAX_RECORDS) {
		state.records.splice(0, state.records.length - MAX_RECORDS);
	}
}

export function usageTokens(usage: CompactionUsage | undefined): number {
	if (!usage) return 0;
	return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

export interface CompactionTotals {
	compactions: number;
	failures: number;
	shadowedTokens: number;
	summaryTokens: number;
	summaryCostTokens: number;
}

export function computeTotals(state: CompactionState): CompactionTotals {
	const totals: CompactionTotals = {
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
export function netReduction(record: CompactionRecord): number {
	return record.shadowedTokens - record.summaryTokens;
}

// ---------------------------------------------------------------------------
// Event folding — pure reducer over session/event payloads.
// ---------------------------------------------------------------------------

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
export function foldEvent(
	state: CompactionState,
	open: OpenCompaction | undefined,
	event: { type: string; data: unknown },
	now: () => Date,
): OpenCompaction | undefined {
	if (event.type === "compaction/start") {
		return { turn: (event.data as CompactionStartPayload | null)?.turn ?? null, startedAt: now().toISOString(), summary: undefined };
	}
	if (event.type === "compaction/summary") {
		const summary = event.data as CompactionSummaryPayload;
		if (open) {
			open.summary = summary;
			return open;
		}
		// summary without start (crash recovery): record immediately.
		appendRecord(state, recordFrom(now().toISOString(), null, summary, undefined));
		return undefined;
	}
	if (event.type === "compaction/end") {
		const end = (event.data as CompactionEndPayload | null) ?? ({} as CompactionEndPayload);
		if (open) {
			appendRecord(state, recordFrom(open.startedAt, open.turn, open.summary, end.error));
		} else if (end.error) {
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

function recordFrom(
	time: string,
	turn: number | null,
	summary: CompactionSummaryPayload | undefined,
	error: string | undefined,
): CompactionRecord {
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
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Report rendering — pure.
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
	return value.length >= width ? value : `${value} `;
}

export function formatStatsReport(state: CompactionState, limit = 10): string {
	if (state.records.length === 0) {
		return "dsh-compact: no compactions recorded in this session yet.";
	}
	const totals = computeTotals(state);
	const lines: string[] = [];
	lines.push(
		`dsh-compact — ${totals.compactions} compaction(s), ${totals.failures} failure(s)`,
	);
	const net = totals.shadowedTokens - totals.summaryTokens;
	lines.push(
		`shadowed ${totals.shadowedTokens.toLocaleString()} tok · summaries ~${totals.summaryTokens.toLocaleString()} tok · net −${net.toLocaleString()} tok on the surface`,
	);
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
