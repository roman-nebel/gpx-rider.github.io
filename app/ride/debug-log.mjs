// Persists an append-only diagnostic event journal independently of FIT recordings.
import { RIDE_DEBUG } from "../core/tuning.mjs";

const DATABASE = "gpx-rider-debug";
const STORE = "chunks";
const HEALTH_KEY = "gpx-rider-debug:storage-warning";

function warningStore() {
  try { return globalThis.process?.versions?.node ? null : globalThis.localStorage; }
  catch { return null; }
}

function encode(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (item instanceof Error || (typeof DOMException === "function" && item instanceof DOMException)) {
      return { name: item.name, message: item.message, code: item.code };
    }
    if (ArrayBuffer.isView(item)) return Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
    if (item instanceof ArrayBuffer) return Array.from(new Uint8Array(item));
    return item;
  });
}

export class DebugLog {
  constructor(config = RIDE_DEBUG, databaseFactory = globalThis.indexedDB) {
    this.config = config;
    this.factory = databaseFactory;
    this.warningStore = warningStore();
    this.db = null;
    this.ready = null;
    this.flushing = null;
    this.timer = null;
    this.pending = [];
    this.memory = [];
    this.storedEvents = 0;
    this.droppedEvents = 0;
    this.error = null;
    this.writeFailed = false;
    this.readFailed = false;
    this.clearing = false;
    this.eventsDuringClear = 0;
    this.sequence = 0;
    this.sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    this.onStatus = null;
    this.previousWarning = null;
  }

  init() {
    this.ready ??= this.open().catch(error => {
      this.error = [this.error, error.message].filter(Boolean).join("; ");
      this.writeFailed = true;
    }).then(() => {
      try {
        const previous = JSON.parse(this.warningStore?.getItem(HEALTH_KEY) ?? "null");
        if (previous) {
          this.previousWarning = previous;
          this.record("debug.previous-storage-warning", previous);
        }
      } catch { /* Storage warnings must never block ride startup. */ }
      this.notify();
    });
    return this.ready;
  }

  async open() {
    if (!this.factory) throw new Error("Persistent diagnostic storage is unavailable.");
    this.db = await new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains(STORE)
          ? request.transaction.objectStore(STORE) : request.result.createObjectStore(STORE, { autoIncrement: true });
        if (!store.indexNames.contains("count")) store.createIndex("count", "count");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Diagnostic storage is blocked by another tab."));
    });
    this.db.onversionchange = () => {
      this.db.close();
      this.writeFailed = true;
      this.error = "Diagnostic storage changed in another tab. Reload to reconnect.";
      this.notify();
    };
    await this.transaction("readonly", store => {
      const request = store.index("count").openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        this.storedEvents += cursor.key;
        cursor.continue();
      };
    });
  }

  status() {
    return {
      persistence: this.db && !this.writeFailed ? "indexeddb" : "memory",
      storedEvents: this.storedEvents,
      storedHistoryAvailable: Boolean(this.db) && !this.readFailed,
      pendingEvents: this.pending.length,
      memoryEvents: this.memory.length,
      droppedEvents: this.droppedEvents,
      error: this.error,
      previousStorageWarning: this.previousWarning,
    };
  }

  notify() {
    if (this.error || this.droppedEvents) {
      try {
        this.warningStore?.setItem(HEALTH_KEY, JSON.stringify({ sessionId: this.sessionId,
          wallTimeMs: Date.now(), persistence: this.status().persistence, memoryEvents: this.memory.length,
          pendingEvents: this.pending.length, droppedEvents: this.droppedEvents, error: this.error, note: "Diagnostic events may be missing. Memory-only data does not survive reload." }));
      } catch { /* Memory fallback may also lack localStorage. */ }
    }
    this.onStatus?.(this.status());
  }

  record(type, data) {
    void this.init();
    const id = `${this.sessionId}:${++this.sequence}`;
    if (this.clearing) { this.eventsDuringClear++; return id; }
    let line;
    try {
      line = encode({ id, sessionId: this.sessionId, wallTimeMs: Date.now(), monotonicMs: performance.now(), type, data }) + "\n";
    } catch (error) {
      this.droppedEvents++;
      this.error = `Could not serialize diagnostic event: ${error.message}`;
      this.notify();
      return id;
    }
    if (this.pending.length < this.config.pending_limit_events) this.pending.push(line);
    else this.droppedEvents++;
    if (!this.timer && !this.flushing) {
      this.timer = setTimeout(() => { void this.flush(); }, this.pending.length >= this.config.batch_events ? 0 : this.config.flush_interval_ms);
      this.timer.unref?.();
    }
    return id;
  }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      return this.flush();
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.flushing = this.writePending();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
      this.notify();
      if (this.pending.length && !this.timer) {
        this.timer = setTimeout(() => { void this.flush(); }, this.config.flush_interval_ms);
        this.timer.unref?.();
      }
    }
  }

  async writePending() {
    await this.init();
    const lines = this.pending.splice(0);
    if (!lines.length) return;
    if (this.db && !this.writeFailed) {
      try {
        await this.transaction("readwrite", store => {
          for (let i = 0; i < lines.length; i += this.config.batch_events) {
            const batch = lines.slice(i, i + this.config.batch_events);
            store.add({ count: batch.length, lines: batch.join("") });
          }
        });
        this.storedEvents += lines.length;
        return;
      } catch (error) {
        this.writeFailed = true;
        this.error = error.message;
      }
    }
    this.memory.push(...lines);
    const excess = Math.max(0, this.memory.length - this.config.memory_limit_events);
    this.memory.splice(0, excess);
    this.droppedEvents += excess;
  }

  transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE, mode);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Diagnostic transaction aborted."));
      transaction.onerror = () => reject(transaction.error ?? new Error("Diagnostic transaction failed."));
      operation(transaction.objectStore(STORE));
    });
  }

  readChunks(visit) {
    return this.transaction("readonly", store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        visit(cursor.value);
        cursor.continue();
      };
    });
  }

  async export() {
    await this.flush();
    const parts = [encode({ type: "debug.header", schemaVersion: 1, exportedAt: new Date().toISOString(),
      format: "GPX Rider diagnostic JSONL", units: { speed: "km/h", distance: "m", power: "W", mass: "kg", grade: "percent", time: "event clocks and sample timestamps: ms; durations named Seconds: s; recording sample t: Unix seconds" },
      nonFiniteNumbers: "Infinity, -Infinity, and NaN are encoded as strings", clock: "monotonicMs and sample timestamps are local to each sessionId",
    }) + "\n"];
    let exportedEvents = 0;
    if (this.db) {
      try {
        await this.readChunks(chunk => { parts.push(chunk.lines); exportedEvents += chunk.count; });
      } catch (error) {
        this.readFailed = true;
        this.error = `Stored diagnostic history could not be read: ${error.message}`;
        this.notify();
      }
    }
    const memory = this.memory.slice();
    parts.push(...memory);
    exportedEvents += memory.length;
    parts.push(encode({ type: "debug.footer", exportedEvents, health: this.status() }) + "\n");
    return new Blob(parts, { type: "application/x-ndjson" });
  }

  async clear() {
    this.clearing = true;
    this.eventsDuringClear = 0;
    try {
      await this.flush();
      if (this.db) await this.transaction("readwrite", store => store.clear());
      this.pending = [];
      this.memory = [];
      this.storedEvents = 0;
      this.droppedEvents = 0;
      this.previousWarning = null;
      this.readFailed = false;
      this.writeFailed = !this.db;
      if (this.db) this.error = null;
      try { this.warningStore?.removeItem(HEALTH_KEY); } catch { /* Optional warning marker. */ }
    } catch (error) {
      this.droppedEvents += this.eventsDuringClear;
      this.error = `Could not clear diagnostic history: ${error.message}`;
      throw error;
    } finally {
      this.clearing = false;
      this.notify();
    }
  }
}

const journal = new DebugLog();

export function recordDebugEvent(type, data) {
  return journal.record(type, data);
}

export function rideDebugLog() {
  return journal;
}
