/**
 * e2e — drives the plugin's apply() against a mock Cordis context that
 * implements the dsh surfaces the plugin touches:
 *
 *   ctx.on("session/event", handler)   → session firehose
 *   ctx.commands.register(definition)  → command registry
 *
 * The harness replays a realistic session event stream (interleaved turn
 * events and a full compaction lifecycle) and verifies persistence through
 * an in-memory store, the /compact-stats command output, and resume via
 * restore().
 */

import { describe, expect, it } from "vitest";
import { apply, Config as configSchema, restore, type CompactionStore } from "../src/index";
import type { CompactionState } from "../src/engine";

class MemoryStore implements CompactionStore {
	saved: CompactionState[] = [];

	load(): CompactionState | undefined {
		return this.saved[this.saved.length - 1];
	}

	save(state: CompactionState): void {
		this.saved.push(state);
	}
}

class MockContext {
	sessionHandlers: Array<(session: unknown, event: { type: string; data: unknown }) => void> = [];
	registeredCommands: Array<{
		name: string;
		description: string;
		handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text?: string }>;
	}> = [];
	commands = {
		register: (definition: {
			name: string;
			description: string;
			handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text?: string }>;
		}) => {
			this.registeredCommands.push(definition);
			return () => undefined;
		},
	};

	on(event: string, handler: never): () => void {
		if (event === "session/event") {
			this.sessionHandlers.push(handler as unknown as (s: unknown, e: { type: string; data: unknown }) => void);
		}
		return () => undefined;
	}

	emit(event: { type: string; data: unknown }): void {
		for (const handler of this.sessionHandlers) handler({}, event);
	}
}

function fullLifecycle(turn: number, shadowed = 48_000) {
	return [
		{ type: "turn/start", data: { turn } },
		{ type: "compaction/start", data: { turn } },
		{
			type: "compaction/summary",
			data: {
				summary: "Fixed the login bug in auth.ts; next step is rate limiting.",
				shadowedTokenCount: shadowed,
				shadowedSeqs: [10, 11, 12],
				provider: "deepseek",
				model: "deepseek-chat",
				usage: { inputTokens: 30_000, outputTokens: 200, totalTokens: 30_200 },
			},
		},
		{ type: "compaction/end", data: { turn } },
		{ type: "turn/end", data: { turn, reason: "completed" } },
	];
}

describe("dsh-compact e2e — plugin against a mocked session firehose", () => {
	it("registers the /compact-stats command", () => {
		const mock = new MockContext();
		apply(mock as never, { reportRows: 10, persist: true });
		expect(mock.registeredCommands.map((c) => c.name)).toEqual(["compact-stats"]);
	});

	it("accounts a full compaction lifecycle amid unrelated events", () => {
		const mock = new MockContext();
		const store = new MemoryStore();
		const handles = apply(mock as never, { reportRows: 10, persist: true }, store);

		for (const event of fullLifecycle(3)) {
			mock.emit(event);
		}
		// a second, smaller compaction
		for (const event of fullLifecycle(7, 12_000)) {
			mock.emit(event);
		}

		const records = handles.records();
		expect(records).toHaveLength(2);
		expect(records[0]?.turn).toBe(3);
		expect(records[0]?.shadowedTokens).toBe(48_000);
		expect(records[1]?.turn).toBe(7);

		// persistence: one save per compaction event (3 per lifecycle)
		expect(store.saved.length).toBe(6);

		const report = handles.report();
		expect(report).toContain("2 compaction(s), 0 failure(s)");
		expect(report).toContain("shadowed 60,000 tok");
		expect(report).toContain("deepseek-chat");
	});

	it("reports failures and keeps counting after an error", () => {
		const mock = new MockContext();
		const handles = apply(mock as never, { reportRows: 10, persist: true });

		mock.emit({ type: "compaction/start", data: { turn: 1 } });
		mock.emit({ type: "compaction/end", data: { turn: 1, error: "summary" } });
		for (const event of fullLifecycle(2)) mock.emit(event);

		const report = handles.report();
		expect(report).toContain("1 compaction(s), 1 failure(s)");
		expect(report).toContain("FAILED");
	});

	it("survives resume: a fresh plugin instance loads persisted state", () => {
		const first = new MockContext();
		const store = new MemoryStore();
		const handles = apply(first as never, { reportRows: 10, persist: true }, store);
		for (const event of fullLifecycle(3)) first.emit(event);
		expect(handles.records()).toHaveLength(1);

		// a fresh context with the same store resumes where the first left off
		const second = new MockContext();
		const secondHandles = apply(second as never, { reportRows: 10, persist: true }, store);
		expect(secondHandles.report()).toContain("1 compaction(s), 0 failure(s)");
		expect(secondHandles.report()).toContain("shadowed 48,000 tok");

		// restore() also filters malformed persisted payloads
		expect(restore({ records: [{ bogus: true }] }).records).toHaveLength(0);
	});

	it("exposes results through the /compact-stats command handler", async () => {
		const mock = new MockContext();
		const handles = apply(mock as never, { reportRows: 10, persist: true });
		for (const event of fullLifecycle(3)) mock.emit(event);

		const command = mock.registeredCommands.find((c) => c.name === "compact-stats");
		expect(command).toBeDefined();
		const result = await command!.handler({});
		expect(result.kind).toBe("success");
		expect(result.text).toBe(handles.report());
	});

	it("skips persistence when disabled", () => {
		const mock = new MockContext();
		const store = new MemoryStore();
		const handles = apply(mock as never, { reportRows: 10, persist: false }, store);

		for (const event of fullLifecycle(1)) mock.emit(event);

		expect(handles.records()).toHaveLength(1);
		expect(store.saved).toHaveLength(0);
	});

	it("fills config defaults via the Schemastery schema", () => {
		const validated = configSchema({} as never);
		expect(validated.reportRows).toBe(10);
		expect(validated.persist).toBe(true);
	});
});
