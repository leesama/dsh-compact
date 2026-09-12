import { describe, expect, it } from "vitest";
import {
	appendRecord,
	computeTotals,
	emptyState,
	estimateTokens,
	foldEvent,
	formatStatsReport,
	netReduction,
	restoreState,
	type CompactionRecord,
	type OpenCompaction,
} from "../../src/engine";

const NOW = () => new Date("2026-09-11T12:00:00.000Z");

function summaryPayload(overrides: Record<string, unknown> = {}) {
	return {
		summary: "Discussed the login bug and fixed auth.ts. Next: rate limiting.",
		shadowedTokenCount: 48_000,
		shadowedSeqs: [12, 13, 14, 15],
		provider: "deepseek",
		model: "deepseek-chat",
		usage: { inputTokens: 40_000, outputTokens: 300, totalTokens: 40_300 },
		...overrides,
	};
}

describe("restoreState", () => {
	it("restores valid records", () => {
		const state = restoreState({ records: [record()] });
		expect(state.records).toHaveLength(1);
	});

	it("filters malformed records and garbage input", () => {
		expect(restoreState({ records: [record(), { bogus: true }, "x"] }).records).toHaveLength(1);
		expect(restoreState(undefined)).toEqual(emptyState());
		expect(restoreState("nope")).toEqual(emptyState());
		expect(restoreState({ records: "not-array" })).toEqual(emptyState());
	});
});

function record(overrides: Partial<CompactionRecord> = {}): CompactionRecord {
	return {
		time: "2026-09-11T12:00:00.000Z",
		turn: 3,
		provider: "deepseek",
		model: "deepseek-chat",
		shadowedTokens: 48_000,
		summaryChars: 4000,
		summaryTokens: 1000,
		usage: { inputTokens: 40_000, outputTokens: 300, totalTokens: 40_300 },
		shadowedSeqs: 4,
		...overrides,
	};
}

describe("appendRecord", () => {
	it("caps history at 200 records", () => {
		const state = emptyState();
		for (let i = 0; i < 205; i += 1) {
			appendRecord(state, record({ time: `2026-09-11T${String(i % 24).padStart(2, "0")}:00:00.000Z` }));
		}
		expect(state.records).toHaveLength(200);
	});
});

describe("estimateTokens", () => {
	it("estimates chars/4 rounded up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("netReduction", () => {
	it("is shadowed minus summary tokens", () => {
		expect(netReduction(record())).toBe(47_000);
	});
});

describe("computeTotals", () => {
	it("separates successes from failures and sums tokens", () => {
		const state = emptyState();
		appendRecord(state, record());
		appendRecord(state, record({ shadowedTokens: 20_000, summaryTokens: 500 }));
		appendRecord(state, record({ error: "summary", shadowedTokens: 0, summaryTokens: 0 }));
		const totals = computeTotals(state);
		expect(totals.compactions).toBe(2);
		expect(totals.failures).toBe(1);
		expect(totals.shadowedTokens).toBe(68_000);
		expect(totals.summaryTokens).toBe(1500);
		expect(totals.summaryCostTokens).toBe(80_600);
	});
});

describe("foldEvent", () => {
	it("folds the full start → summary → end lifecycle", () => {
		const state = emptyState();
		let open: OpenCompaction | undefined;

		open = foldEvent(state, open, { type: "compaction/start", data: { turn: 3 } }, NOW);
		expect(open?.turn).toBe(3);

		open = foldEvent(state, open, { type: "compaction/summary", data: summaryPayload() }, NOW);
		expect(state.records).toHaveLength(0); // not closed yet
		expect(open?.summary?.shadowedTokenCount).toBe(48_000);

		open = foldEvent(state, open, { type: "compaction/end", data: { turn: 3 } }, NOW);
		expect(open).toBeUndefined();
		expect(state.records).toHaveLength(1);

		const first = state.records[0]!;
		expect(first.turn).toBe(3);
		expect(first.shadowedTokens).toBe(48_000);
		expect(first.shadowedSeqs).toBe(4);
		expect(first.model).toBe("deepseek-chat");
		expect(first.summaryTokens).toBe(estimateTokens(summaryPayload().summary));
		expect(first.error).toBeUndefined();
	});

	it("records failures with their error code", () => {
		const state = emptyState();
		let open: OpenCompaction | undefined;
		open = foldEvent(state, open, { type: "compaction/start", data: { turn: 5 } }, NOW);
		open = foldEvent(state, open, { type: "compaction/end", data: { turn: 5, error: "summary" } }, NOW);
		expect(state.records[0]?.error).toBe("summary");
	});

	it("handles manual compaction (turn null)", () => {
		const state = emptyState();
		let open: OpenCompaction | undefined;
		open = foldEvent(state, open, { type: "compaction/start", data: { turn: null } }, NOW);
		open = foldEvent(state, open, { type: "compaction/summary", data: summaryPayload() }, NOW);
		open = foldEvent(state, open, { type: "compaction/end", data: { turn: null } }, NOW);
		expect(state.records[0]?.turn).toBeNull();
	});

	it("recovers a summary without start (crash recovery)", () => {
		const state = emptyState();
		const open = foldEvent(state, undefined, { type: "compaction/summary", data: summaryPayload() }, NOW);
		expect(open).toBeUndefined();
		expect(state.records).toHaveLength(1);
		expect(state.records[0]?.shadowedTokens).toBe(48_000);
	});

	it("records a bare failed end without start", () => {
		const state = emptyState();
		const open = foldEvent(state, undefined, { type: "compaction/end", data: { turn: 2, error: "busy" } }, NOW);
		expect(open).toBeUndefined();
		expect(state.records[0]?.error).toBe("busy");
	});

	it("ignores unrelated events and passes through the open compaction", () => {
		const state = emptyState();
		let open: OpenCompaction | undefined;
		open = foldEvent(state, open, { type: "compaction/start", data: { turn: 1 } }, NOW);
		open = foldEvent(
			state,
			open,
			{ type: "assistant/message", data: { turn: 1, step: 2, message: {} } },
			NOW,
		);
		expect(open?.turn).toBe(1);
		expect(state.records).toHaveLength(0);
	});

	it("defaults missing summary fields gracefully", () => {
		const state = emptyState();
		let open: OpenCompaction | undefined;
		open = foldEvent(state, open, { type: "compaction/start", data: null }, NOW);
		open = foldEvent(state, open, { type: "compaction/end", data: null }, NOW);
		expect(state.records[0]).toMatchObject({
			turn: null,
			shadowedTokens: 0,
			summaryTokens: 0,
		});
	});
});

describe("formatStatsReport", () => {
	it("reports the empty state", () => {
		expect(formatStatsReport(emptyState())).toContain("no compactions recorded");
	});

	it("renders totals, per-compaction rows, and failures", () => {
		const state = emptyState();
		appendRecord(state, record({ time: "2026-09-11T12:00:01.000Z" }));
		appendRecord(
			state,
			record({ time: "2026-09-11T12:00:02.000Z", error: "cancelled", shadowedTokens: 0, summaryTokens: 0 }),
		);
		const report = formatStatsReport(state);
		expect(report).toContain("1 compaction(s), 1 failure(s)");
		expect(report).toContain("shadowed 48,000 tok");
		expect(report).toContain("net −47,000 tok");
		expect(report).toContain("summary LLM cost: 40,300 tok");
		expect(report).toContain("deepseek-chat");
		expect(report).toContain("FAILED");
		// newest first
		const failedIndex = report.indexOf("FAILED");
		const modelIndex = report.indexOf("deepseek-chat");
		expect(failedIndex).toBeGreaterThan(-1);
		expect(failedIndex).toBeLessThan(modelIndex);
	});
});
