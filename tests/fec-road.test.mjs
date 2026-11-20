import test from "node:test";
import assert from "node:assert/strict";
import { connectFec, resetFec, sendFecGrade, sendFecMinimumResistance, sendFecTargetPower } from "../app/trainer/trainer-fec.mjs";
import { TrainerRoad } from "../app/trainer/trainer-road.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";

async function connect(writeValue) {
  await connectFec({ getCharacteristic: async (uuid) => uuid.startsWith("6e40fec3")
    ? { writeValue }
    : { addEventListener() {}, startNotifications: async () => {} } }, { displayName: "Test FE-C" });
}

test("FE-C restores simulation after basic minimum load even at an unchanged route grade", async () => {
  const writes = [];
  await connect(async (bytes) => { writes.push([...bytes]); });
  await sendFecGrade(5, { config: ROAD_PHYSICS });
  assert.deepEqual(writes.map(([page]) => page), [55, 50, 51]);
  await sendFecMinimumResistance();
  assert.deepEqual(writes.at(-1), [48, 255, 255, 255, 255, 255, 255, 0]);
  await sendFecGrade(5, { config: ROAD_PHYSICS });
  assert.equal(writes.at(-1)[0], 51);
  assert.deepEqual(writes.map(([page]) => page), [55, 50, 51, 48, 51]);
  resetFec();
});

test("queued FE-C minimum and power writes validate ownership before touching hardware", async () => {
  const writes = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await connect(async (bytes) => { writes.push([...bytes]); await blocked; });
  const first = sendFecTargetPower(200);
  let current = true;
  const obsoleteMinimum = sendFecMinimumResistance(() => current);
  const obsoletePower = sendFecTargetPower(250, () => current);
  await new Promise(setImmediate);
  current = false;
  release();
  await Promise.all([first, obsoleteMinimum, obsoletePower]);
  assert.deepEqual(writes.map(([page]) => page), [49]);
  resetFec();
});

function roadController() {
  let erg = false;
  let now = 0;
  const controller = new TrainerRoad(ROAD_PHYSICS, () => now);
  controller.attach({
    kind: "fec", isErg: () => erg,
    sendFec: (grade, config, minimum, allowWrite, allowContinue) => minimum
      ? sendFecMinimumResistance(allowWrite)
      : sendFecGrade(grade, { config, allowWrite, allowContinue }),
    onApplied() {}, onError(error) { throw error; },
  });
  return { controller, setErg(value) { erg = value; controller.invalidate(); }, setNow(value) { now = value; } };
}

test("FE-C leaves ERG at the same grade when the road controller forces a mode change", async () => {
  const writes = [];
  await connect(async (bytes) => { writes.push([...bytes]); });
  const { controller, setErg } = roadController();
  await controller.sendGrade(5);
  setErg(true);
  await sendFecTargetPower(200);
  setErg(false);
  await controller.sendGrade(5, { force: true });
  assert.deepEqual(writes.map(([page]) => page), [55, 50, 51, 49, 51]);
  resetFec();
});

test("FE-C completes an intermediate ramp packet when newer ramp values arrive during BLE writes", async () => {
  const writes = [];
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { started = resolve; });
  await connect(async (bytes) => {
    writes.push([...bytes]);
    if (writes.length === 1) { started(); await blocked; }
  });
  const { controller, setNow } = roadController();
  const first = controller.setLoad(0.1);
  await writing;
  void controller.setLoad(0.2);
  release();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(writes.map(([page]) => page), [55, 50, 51]);
  assert.equal(writes.at(-1)[7], 10); // Crr at 10% load.
  setNow(150);
  await controller.setLoad(0.3);
  assert.deepEqual(writes.map(([page]) => page), [55, 50, 51, 50, 51]);
  assert.equal(writes.at(-1)[7], 30);
  resetFec();
});


for (const mode of ["ERG", "minimum resistance"]) {
  test(`FE-C cancels the rest of a started road packet when switching to ${mode}`, async () => {
    const writes = [];
    let release;
    let started;
    const blocked = new Promise((resolve) => { release = resolve; });
    const writing = new Promise((resolve) => { started = resolve; });
    await connect(async (bytes) => {
      writes.push([...bytes]);
      if (writes.length === 1) { started(); await blocked; }
    });
    const { controller, setErg } = roadController();
    const ramp = controller.setLoad(0.1);
    await writing;
    let next;
    if (mode === "ERG") {
      setErg(true);
      next = sendFecTargetPower(200);
    } else {
      next = controller.setLoad(0);
    }
    release();
    await Promise.all([ramp, next]);
    await new Promise(setImmediate);
    assert.deepEqual(writes.map(([page]) => page), [55, mode === "ERG" ? 49 : 48]);
    resetFec();
  });
}
