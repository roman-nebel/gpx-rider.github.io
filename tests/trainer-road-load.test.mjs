import test from "node:test";
import assert from "node:assert/strict";
import { TrainerRoad } from "../app/trainer/trainer-road.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";

function fixture(overrides = {}) {
  const writes = [];
  const errors = [];
  let erg = false;
  const controller = new TrainerRoad(ROAD_PHYSICS);
  const connection = {
    kind: "ftms", minimumResistance: 20, simulation: true,
    isErg: () => erg,
    send: async (bytes, valid) => { if (!valid()) return false; writes.push([...bytes]); return true; },
    onApplied() {}, onError: (error) => errors.push(error.message), ...overrides,
  };
  controller.attach(connection);
  return { controller, writes, errors, connection, setErg: (value) => { erg = value; controller.invalidate(); } };
}

test("freewheeling sends the actual minimum, then progressively restores all road terms", async () => {
  const { controller, writes } = fixture();
  await controller.sendGrade(8);
  await controller.setLoad(0);
  assert.deepEqual(writes.at(-1), [4, 20, 0]);
  await controller.sendGrade(-12);
  assert.deepEqual(writes.at(-1), [4, 20, 0]);
  await controller.setLoad(0.5);
  assert.deepEqual(writes.at(-1), [17, 0, 0, 0xa8, 0xfd, 25, 15]);
  await controller.setLoad(1);
  assert.deepEqual(writes.at(-1), [17, 0, 0, 0x50, 0xfb, 50, 29]);
});

test("without a resistance range, minimum simulation load contains no road forces", async () => {
  const { controller, writes } = fixture({ minimumResistance: null });
  await controller.sendGrade(15);
  await controller.setLoad(0);
  assert.deepEqual(writes.at(-1), [17, 0, 0, 0, 0, 0, 0]);
});

test("an explicitly rejected minimum command falls back to zero simulation load", async () => {
  const calls = [];
  const { controller, errors } = fixture({ send: async (bytes) => {
    calls.push([...bytes]);
    if (bytes[0] === 4) throw new Error("Op code not supported");
    return true;
  } });
  await controller.setLoad(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [[4, 20, 0], [17, 0, 0, 0, 0, 0, 0]]);
  assert.deepEqual(errors, []);
});

test("ERG excludes both minimum resistance and the road-load ramp", async () => {
  const { controller, writes, setErg } = fixture();
  await controller.sendGrade(0);
  setErg(true);
  await controller.setLoad(0);
  await controller.setLoad(0.5);
  assert.equal(writes.length, 1);
  setErg(false);
  await controller.setLoad(1);
  assert.equal(writes.length, 2);
});

test("a newer load request supersedes an old queued minimum command", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const { controller } = fixture({ send: async (bytes, valid) => {
    await blocked;
    if (!valid()) return false;
    writes.push([...bytes]);
    return true;
  } });
  const minimum = controller.setLoad(0);
  const restore = controller.setLoad(1);
  release();
  await Promise.all([minimum, restore]);
  await new Promise(setImmediate);
  assert.deepEqual(writes, [[17, 0, 0, 0, 0, 50, 29]]);
});

test("FE-C selects basic resistance for minimum load and simulation again after engagement", async () => {
  const calls = [];
  const { controller } = fixture({ kind: "fec", sendFec: async (grade, config, minimum, valid) => {
    if (!valid()) return false;
    calls.push({ grade, config, minimum });
    return true;
  } });
  await controller.sendGrade(5);
  await controller.setLoad(0);
  assert.equal(calls.at(-1).minimum, true);
  await controller.setLoad(1);
  assert.equal(calls.at(-1).minimum, false);
  assert.equal(calls.at(-1).grade, 5);
  assert.equal(calls.at(-1).config.rolling_resistance_coefficient, ROAD_PHYSICS.rolling_resistance_coefficient);
});

test("intermediate ramp commands are rate-limited while minimum and full load remain immediate", async () => {
  let now = 0;
  const writes = [];
  const controller = new TrainerRoad({ ...ROAD_PHYSICS, trainer_load_interval_ms: 150 }, () => now);
  controller.attach({ kind: "ftms", simulation: true, minimumResistance: 0, isErg: () => false,
    send: async (bytes) => { writes.push([...bytes]); return true; }, onApplied() {}, onError() {} });
  await controller.setLoad(0.1);
  now = 50;
  await controller.setLoad(0.2);
  assert.equal(writes.length, 1);
  now = 150;
  await controller.setLoad(0.3);
  assert.equal(writes.length, 2);
  await controller.setLoad(0);
  assert.deepEqual(writes.at(-1), [4, 0, 0]);
  await controller.setLoad(1);
  assert.deepEqual(writes.at(-1), [17, 0, 0, 0, 0, 50, 29]);
});

test("trainer braking adds bounded load and cancels downhill assistance without changing the route grade", async () => {
  const { controller, writes } = fixture();
  await controller.sendGrade(-10);
  await controller.setLoad(1, 1);
  const grade = () => new DataView(Uint8Array.from(writes.at(-1)).buffer).getInt16(3, true) / 100;
  assert.equal(grade(), 6);
  assert.equal(controller.grade, -10);
  await controller.sendGrade(5, { force: true });
  assert.equal(grade(), 11);
  await controller.sendGrade(20, { force: true });
  assert.equal(grade(), 20);
  await controller.setLoad(0, 1);
  assert.deepEqual(writes.at(-1), [4, 20, 0]);
  assert.equal(controller.brakeStrength, 0);
});

test("queued extra braking is canceled when ERG takes control", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const { controller, setErg } = fixture({ send: async (bytes, valid) => {
    await blocked;
    if (!valid()) return false;
    writes.push([...bytes]);
    return true;
  } });
  const braking = controller.setLoad(1, 1);
  setErg(true);
  await controller.setLoad(1, 0);
  release();
  await braking;
  assert.deepEqual(writes, []);
});

test("FE-C carries extra brake load through track resistance, with no ERG target", async () => {
  const calls = [];
  const { controller } = fixture({ kind: "fec", sendFec: async (grade, config, minimum, valid) => {
    if (!valid()) return false;
    calls.push({ grade, minimum });
    return true;
  } });
  await controller.sendGrade(-8);
  await controller.setLoad(1, 1);
  assert.deepEqual(calls.at(-1), { grade: 6, minimum: false });
});


test("finishing clears extra braking and sends flat road load as one target", async () => {
  const { controller, writes } = fixture();
  await controller.sendGrade(8);
  await controller.setLoad(1, 1);
  writes.length = 0;
  await controller.setLoad(1, 0, 0);
  assert.deepEqual(writes, [[17, 0, 0, 0, 0, 50, 29]]);
  assert.equal(controller.brakeStrength, 0);
});

test("uphill compensation reaches FTMS as extra grade and clears at minimum load", async () => {
  const { controller, writes } = fixture();
  await controller.setLoad(1, 0, 12, 3);
  const grade = () => new DataView(Uint8Array.from(writes.at(-1)).buffer).getInt16(3, true) / 100;
  assert.equal(grade(), 15);
  assert.equal(writes.at(-1)[5], 50);
  await controller.setLoad(0, 0, 12, 3);
  assert.deepEqual(writes.at(-1), [4, 20, 0]);
  assert.equal(controller.uphillGradePercent, 0);
  await controller.setLoad(1, 0, 12, 0);
  assert.equal(grade(), 12);
});

test("uphill feedback is bounded, rate-limited, and cannot override ERG", async () => {
  const { controller, writes, setErg } = fixture();
  let now = 0;
  controller.now = () => now;
  await controller.setLoad(1, 0, 10, 100);
  assert.equal(controller.uphillGradePercent, ROAD_PHYSICS.trainer_uphill_max_grade_percent);
  const count = writes.length;
  now = 1;
  await controller.setLoad(1, 0, 10, 8);
  assert.equal(writes.length, count);
  now = ROAD_PHYSICS.trainer_load_interval_ms;
  await controller.sendGrade(10);
  assert.equal(writes.length, count + 1);
  setErg(true);
  await controller.setLoad(1, 0, 10, 5);
  assert.equal(writes.length, count + 1);
});

test("FE-C carries uphill compensation as track grade without an ERG target", async () => {
  const calls = [];
  const { controller } = fixture({ kind: "fec", sendFec: async (grade, config, minimum, valid) => {
    if (!valid()) return false;
    calls.push({ grade, minimum });
    return true;
  } });
  await controller.setLoad(1, 0, 15, 4);
  assert.deepEqual(calls.at(-1), { grade: 19, minimum: false });
  await controller.setLoad(1, 0, 0, 0);
  assert.deepEqual(calls.at(-1), { grade: 0, minimum: false });
});
