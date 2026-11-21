import test from "node:test";
import assert from "node:assert/strict";
import { advanceFreewheel, createFreewheel } from "../app/ride/freewheel.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";

const config = { ...ROAD_PHYSICS, engagement_speed_tolerance_kph: 0.5, engagement_release_gap_kph: 2,
  engagement_hold_seconds: 0.3, engagement_ramp_seconds: 1 };
const tick = (coupling, speed, effort, dt = 0.1, grade = 0) => advanceFreewheel(coupling, speed, {
  trainerSpeedKph: 10, pedaling: true, powerWatts: 200, ...effort,
  elapsedSeconds: dt, gradePercent: grade, config,
});

test("pedaling below road speed keeps freewheeling at minimum load", () => {
  const coast = tick(createFreewheel(), 30, { pedaling: false });
  assert.equal(coast.coupling.phase, "freewheel");
  const catchUp = tick(coast.coupling, coast.speedKph, { trainerSpeedKph: 12, powerWatts: 500 });
  assert.equal(catchUp.coupling.phase, "freewheel");
  assert.equal(catchUp.coupling.loadFraction, 0);
  assert.ok(catchUp.speedKph > 29 && catchUp.speedKph < coast.speedKph);
  const noPower = tick(coast.coupling, coast.speedKph, { trainerSpeedKph: 12, powerWatts: 0 });
  assert.equal(noPower.speedKph, catchUp.speedKph);
});

test("engagement requires sustained matching speed, then smoothly restores road load", () => {
  let { coupling, speedKph } = tick(createFreewheel(), 30, { pedaling: false });
  for (let i = 0; i < 2; i++) {
    ({ coupling, speedKph } = tick(coupling, speedKph, { trainerSpeedKph: 30 }));
    assert.equal(coupling.phase, "freewheel");
  }
  ({ coupling, speedKph } = tick(coupling, speedKph, { trainerSpeedKph: 30 }));
  assert.equal(coupling.phase, "engaging");
  const first = tick(coupling, speedKph, { trainerSpeedKph: 30 });
  assert.ok(first.coupling.loadFraction > 0 && first.coupling.loadFraction < 1);
  assert.ok(Math.abs(first.speedKph - speedKph) < 1);
  const done = tick(first.coupling, first.speedKph, { trainerSpeedKph: 30 }, 1);
  assert.equal(done.coupling.phase, "coupled");
  assert.equal(done.coupling.loadFraction, 1);
  assert.equal(done.speedKph, 30);
});

test("speed noise cancels a candidate without toggling resistance", () => {
  const free = tick(createFreewheel(), 30, { pedaling: false });
  const candidate = tick(free.coupling, free.speedKph, { trainerSpeedKph: 30 }, 0.2);
  const lost = tick(candidate.coupling, candidate.speedKph, { trainerSpeedKph: 25 });
  assert.equal(lost.coupling.holdSeconds, 0);
  assert.equal(lost.coupling.loadFraction, 0);
});

test("a normal uphill slowdown while coupled never reopens the freewheel", () => {
  const result = tick(createFreewheel(), 35, { trainerSpeedKph: 15 }, 1, 10);
  assert.equal(result.coupling.phase, "coupled");
  assert.equal(result.coupling.loadFraction, 1);
  assert.equal(result.speedKph, 15);
});

test("falling far behind while engaging returns to minimum load", () => {
  const result = tick({ phase: "engaging", loadFraction: 0.5, holdSeconds: 0.3 }, 30, { trainerSpeedKph: 20 });
  assert.equal(result.coupling.phase, "freewheel");
  assert.equal(result.coupling.loadFraction, 0);
});

test("missing speed cannot engage; downhill coasting still accelerates", () => {
  const result = tick({ phase: "freewheel", loadFraction: 0, holdSeconds: 0 }, 30, { trainerSpeedKph: null }, 1, -8);
  assert.equal(result.coupling.phase, "freewheel");
  assert.ok(result.speedKph > 30);
});

test("a descent opens the freewheel while pedaling when gravity outruns a passive trainer", () => {
  const result = tick(createFreewheel(), 30, { trainerSpeedKph: 30 }, 0.1, -8);
  assert.equal(result.coupling.phase, "freewheel");
  assert.equal(result.coupling.loadFraction, 0);
  assert.ok(result.speedKph > 30);
  const fasterPedaling = tick(result.coupling, result.speedKph, { trainerSpeedKph: 25, powerWatts: 800 }, 1, -8);
  const noPower = tick(result.coupling, result.speedKph, { trainerSpeedKph: 25, powerWatts: 0 }, 1, -8);
  assert.equal(fasterPedaling.speedKph, noPower.speedKph);
});

test("zero measured power opens the freewheel even while cadence is still positive", () => {
  const result = tick(createFreewheel(), 30, { trainerSpeedKph: 20, powerWatts: 0 }, 1);
  assert.equal(result.coupling.phase, "freewheel");
  assert.ok(result.speedKph > 28);
});

test("missing power preserves speed-only riding rather than treating absence as zero effort", () => {
  const result = tick(createFreewheel(), 30, { trainerSpeedKph: 30, powerWatts: null }, 1);
  assert.equal(result.coupling.phase, "coupled");
  assert.equal(result.speedKph, 30);
});


test("a trainer already matching downhill road motion remains coupled", () => {
  const result = tick(createFreewheel(), 30, { trainerSpeedKph: 35 }, 0.1, -8);
  assert.equal(result.coupling.phase, "coupled");
  assert.equal(result.speedKph, 35);
});
