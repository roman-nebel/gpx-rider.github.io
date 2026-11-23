import test from "node:test";
import assert from "node:assert/strict";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";
import { connectTrainer, configureTrainerRoad, initTrainer, isTrainerConnected, queueTrainerTargetPower, sendTrainerGrade, setTrainerRoadLoad, trainerRoadSupport, trainerSupportsTargetPower } from "../app/trainer/trainer.mjs";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() {}, getItem() { return null; } } });

function peripheral({ simulation = true, resistance = false, rejectControl = false } = {}) {
  const writes = [];
  const listeners = new Set();
  const cp = {
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    startNotifications: async () => {},
    async writeValueWithResponse(bytes) {
      writes.push([...bytes]);
      cp.value = new DataView(Uint8Array.of(0x80, bytes[0], rejectControl && bytes[0] === 0 ? 5 : 1).buffer);
      for (const fn of listeners) fn({ target: cp });
    },
  };
  const features = new DataView(new ArrayBuffer(8));
  features.setUint32(4, (simulation ? 1 << 13 : 0) | (resistance ? 1 << 2 : 0) | 1 << 3, true);
  const range = new DataView(new ArrayBuffer(6));
  range.setInt16(2, 1000, true);
  range.setUint16(4, 1, true);
  const resistanceRange = new DataView(Uint8Array.of(20, 0, 0xe8, 3, 10, 0).buffer);
  const service = {
    getCharacteristic: async (uuid) => {
      if (uuid === 0x2ad9) return cp;
      if (uuid === 0x2acc) return { readValue: async () => features };
      if (uuid === 0x2ad8) return { readValue: async () => range };
      if (uuid === 0x2ad6) return { readValue: async () => resistanceRange };
      return { addEventListener() {}, startNotifications: async () => {} };
    },
  };
  const device = { name: "Test trainer", id: "test", addEventListener() {}, gatt: { connected: true, getPrimaryService: async () => service } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  return writes;
}

test("FTMS road configuration is sent once, changes are sent at the same grade, and ERG excludes terrain", async () => {
  const writes = peripheral();
  initTrainer({ onStatus() {}, onTelemetry() {} });
  await connectTrainer();
  assert.equal(trainerSupportsTargetPower(), true);
  configureTrainerRoad(ROAD_PHYSICS);
  await sendTrainerGrade(0);
  assert.deepEqual(writes.at(-1), [0x11, 0, 0, 0, 0, 50, 29]);
  const count = writes.length;
  await sendTrainerGrade(0);
  assert.equal(writes.length, count);
  configureTrainerRoad({ ...ROAD_PHYSICS, rolling_resistance_coefficient: 0.006 });
  await sendTrainerGrade(0);
  assert.equal(writes.at(-1)[5], 60);
  assert.match(trainerRoadSupport(), /accepted/);
  queueTrainerTargetPower(200);
  await new Promise(setImmediate);
  assert.equal(writes.at(-1)[0], 5);
  const ergCount = writes.length;
  await sendTrainerGrade(10, { force: true });
  assert.equal(writes.length, ergCount);
});

test("FTMS discovers and applies the trainer's advertised minimum resistance", async () => {
  const writes = peripheral({ resistance: true });
  await connectTrainer();
  await setTrainerRoadLoad(0);
  assert.deepEqual(writes.at(-1), [4, 20, 0]);
  await setTrainerRoadLoad(1);
  assert.equal(writes.at(-1)[0], 17);
});

test("a trainer that explicitly excludes simulation is never sent road commands", async () => {
  const writes = peripheral({ simulation: false });
  await connectTrainer();
  await sendTrainerGrade(10, { force: true });
  assert.equal(writes.some(([opcode]) => opcode === 0x11), false);
  assert.match(trainerRoadSupport(), /does not advertise/);
});

test("a rejected control handshake never enables trainer writes", async () => {
  const writes = peripheral({ rejectControl: true });
  await connectTrainer();
  await sendTrainerGrade(5, { force: true });
  assert.equal(isTrainerConnected(), false);
  assert.equal(trainerSupportsTargetPower(), false);
  assert.deepEqual(writes.map(([opcode]) => opcode), [0]);
});
