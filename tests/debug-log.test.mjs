import test from "node:test";
import assert from "node:assert/strict";
import { DebugLog } from "../app/ride/debug-log.mjs";

const options = { flush_interval_ms: 100000, batch_events: 128, pending_limit_events: 100, memory_limit_events: 100 };
const create = (overrides = {}) => new DebugLog({ ...options, ...overrides }, undefined);
const events = async (log) => (await (await log.export()).text()).trim().split("\n").map(JSON.parse);

test("diagnostics retain exact bytes, exceptional numbers, errors, and immutable snapshots", async () => {
  const log = create();
  const backing = Uint8Array.of(99, 1, 2, 99);
  const input = { bytes: new DataView(backing.buffer, 1, 2), speed: Infinity, error: new Error("Rejected") };
  log.record("packet", input);
  backing[1] = 9;
  const output = await events(log);
  assert.deepEqual(output.find(e => e.type === "packet").data, { bytes: [1, 2], speed: "Infinity", error: { name: "Error", message: "Rejected" } });
  assert.equal(output[0].schemaVersion, 1);
  assert.equal(output.at(-1).health.persistence, "memory");
});

test("memory limits report every dropped event rather than claiming a complete recording", async () => {
  const log = create({ memory_limit_events: 2 });
  for (let i = 0; i < 5; i++) log.record("sample", { i });
  await log.flush();
  const output = await events(log);
  assert.equal(output.filter(e => e.type === "sample").length, 2);
  assert.equal(output.at(-1).health.droppedEvents, 3);
});

test("export flushes the pending tail and preserves event order and unique IDs", async () => {
  const log = create();
  for (let i = 0; i < 20; i++) log.record("sample", { i });
  const output = (await events(log)).filter(e => e.type === "sample");
  assert.deepEqual(output.map(e => e.data.i), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(new Set(output.map(e => e.id)).size, 20);
});

test("explicit clearing starts a new log without retaining old samples", async () => {
  const log = create();
  log.record("old", {});
  await log.clear();
  log.record("new", {});
  const output = await events(log);
  assert.equal(output.some(e => e.type === "old"), false);
  assert.equal(output.some(e => e.type === "new"), true);
});

test("an unserializable event cannot interrupt the ride and is reported as lost", async () => {
  const log = create();
  const cycle = {}; cycle.self = cycle;
  assert.doesNotThrow(() => log.record("invalid", cycle));
  log.record("valid", { power: 0 });
  const output = await events(log);
  assert.equal(output.at(-1).health.droppedEvents, 1);
  assert.match(output.at(-1).health.error, /serialize/);
  assert.ok(output.some(e => e.type === "valid"));
});

test("pending storage backpressure reports dropped input events", async () => {
  const log = create({ pending_limit_events: 2 });
  for (let i = 0; i < 5; i++) log.record("sample", { i });
  const output = await events(log);
  assert.equal(output.filter(e => e.type === "sample").length, 2);
  assert.equal(output.at(-1).health.droppedEvents, 3);
});

test("storage failure warnings survive a new page session", async () => {
  const values = new Map();
  const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const first = create(); first.warningStore = store;
  first.record("sample", { power: 0 }); await first.flush();
  const second = create(); second.warningStore = store;
  const output = await events(second);
  const warning = output.find(e => e.type === "debug.previous-storage-warning");
  assert.equal(warning.data.sessionId, first.sessionId);
  assert.equal(warning.data.memoryEvents, 1);
  assert.equal(output.at(-1).health.previousStorageWarning.sessionId, first.sessionId);
});

test("unreadable stored history still permits exporting memory data with a warning", async () => {
  const log = create();
  log.record("memory", { power: 123 }); await log.flush();
  log.db = {};
  log.readChunks = async () => { throw new Error("Storage connection closed"); };
  const output = await events(log);
  assert.ok(output.some(e => e.type === "memory"));
  assert.equal(output.at(-1).health.storedHistoryAvailable, false);
  assert.match(output.at(-1).health.error, /could not be read/);
});

test("clearing excludes concurrent old-context events and then resumes recording", async () => {
  const log = create();
  log.record("old", {}); await log.flush();
  const originalFlush = log.flush.bind(log);
  let resume;
  log.flush = () => new Promise(resolve => { resume = resolve; });
  const clearing = log.clear();
  log.record("during-clear", {});
  resume(); await clearing;
  log.flush = originalFlush;
  log.record("new", {});
  const output = await events(log);
  assert.equal(output.some(e => e.type === "old" || e.type === "during-clear"), false);
  assert.ok(output.some(e => e.type === "new"));
  assert.equal(output.at(-1).health.droppedEvents, 0);
});

test("browser transport exceptions retain their diagnostic name, message, and code", async () => {
  const log = create();
  log.record("error", { error: new DOMException("Not permitted", "SecurityError") });
  const output = await events(log);
  const error = output.find(e => e.type === "error").data.error;
  assert.equal(error.name, "SecurityError");
  assert.equal(error.message, "Not permitted");
  assert.equal(error.code, 18);
});
