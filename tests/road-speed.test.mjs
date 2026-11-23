import test from "node:test";
import assert from "node:assert/strict";
import { enrichRoute } from "../app/route/route.mjs";
import { destinationPoint } from "../app/core/geo.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";
import { advanceCyclingMotion } from "../app/ride/cycling-motion.mjs";
import { cyclingSpeedForPower } from "../app/ride/cycling-speed.mjs";

// Only the state map is needed; the adapter does not access browser controls.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { state } = await import("../app/core/state.mjs");
const { advanceRealRoadSpeed, resetRoadMotion, trainerEffort, realRoadConfig,
  prepareRealRoadMotion, realRoadMoving, finishRoadMotion, advanceFinishedRoadSpeed,
} = await import("../app/ride/road-speed.mjs");

function telemetry({ power = 200, cadence = 85, speed = 30, start = 30, erg = false, inertia = true } = {}) {
  resetRoadMotion();
  const now = performance.now();
  Object.assign(state, {
    trainerPowerWatts: power, trainerCadenceRpm: cadence, trainerSpeedKph: speed,
    trainerPowerSampleAt: power === null ? null : now,
    trainerCadenceSampleAt: cadence === null ? null : now,
    trainerSpeedSampleAt: speed === null ? null : now,
    inertiaEnabled: inertia, workoutErgEnabled: erg,
    workoutErg: erg ? { paused: false, targetWatts: 200 } : null,
    route: [], progressMeters: 0, maxRideSpeedKph: 72, autoCornerBraking: true,
    roadSpeedKph: start, simulatorEnabled: false,
  });
  return now;
}

for (const grade of [-5, 0, 5]) {
  test(`all real modes use the same measured-power dynamics at grade ${grade}% regardless of trainer speed`, () => {
    for (const power of [0, 200, 800]) for (const erg of [false, true]) for (const speed of [0, 30, 100, null]) {
      const now = telemetry({ power, erg, speed, cadence: power ? 85 : 0 });
      const expected = advanceCyclingMotion(30, power, grade, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
      assert.deepEqual(advanceRealRoadSpeed(1, grade, now), expected);
      assert.equal(state.trainerSpeedKph, speed);
    }
  });
}

test("positive measured power drives road motion even with zero or missing cadence", () => {
  for (const cadence of [0, null, 85]) {
    const now = telemetry({ cadence, speed: 0 });
    const expected = advanceCyclingMotion(30, 200, 5, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
    assert.deepEqual(advanceRealRoadSpeed(1, 5, now), expected);
  }
});

test("starting road speed is zero and never seeded from raw trainer speed", () => {
  const now = telemetry({ speed: 100, start: null });
  prepareRealRoadMotion(trainerEffort(now));
  assert.equal(state.roadSpeedKph, null);
  const expected = advanceCyclingMotion(0, 200, 0, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
  assert.deepEqual(advanceRealRoadSpeed(1, 0, now), expected);
  assert.ok(state.roadSpeedKph < 15);
});

test("raw speed and cadence cannot start a ride without measured power", () => {
  const now = telemetry({ power: null, speed: 100 });
  prepareRealRoadMotion(trainerEffort(now));
  assert.equal(realRoadMoving(), false);
  assert.deepEqual(advanceRealRoadSpeed(1, -10, now), { speedKph: 0, distanceMeters: 0 });
  assert.equal(state.roadSpeedKph, null);
});

test("zero watts is valid coasting data and a spinning trainer cannot propel the rider", () => {
  const now = telemetry({ power: 0, cadence: 0, speed: 100 });
  const expected = advanceCyclingMotion(30, 0, 5, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
  assert.deepEqual(advanceRealRoadSpeed(1, 5, now), expected);
  assert.equal(state.roadCoasting, true);
  telemetry({ power: 0, cadence: 0, speed: 100, start: 0 });
  assert.equal(realRoadMoving(), false);
});

test("fresh speed and cadence cannot hide stale measured power", () => {
  const now = telemetry();
  const later = now + ROAD_PHYSICS.telemetry_timeout_ms + 1;
  state.trainerSpeedSampleAt = state.trainerCadenceSampleAt = later;
  assert.equal(trainerEffort(later).power, null);
  assert.deepEqual(advanceRealRoadSpeed(1, -10, later), { speedKph: 0, distanceMeters: 0 });
  assert.equal(state.roadSpeedKph, null);
});

test("steady modeled speed is shared outside ERG and in ERG when inertia is disabled", () => {
  for (const erg of [false, true]) for (const power of [0, 200]) for (const grade of [-5, 5]) {
    const now = telemetry({ inertia: false, erg, power, speed: 100 });
    const expected = cyclingSpeedForPower(power, grade, { ...realRoadConfig(), max_speed_kph: Infinity });
    const result = advanceRealRoadSpeed(1, grade, now);
    assert.equal(result.speedKph, expected);
    assert.equal(result.distanceMeters, expected / 3.6);
  }
});

test("the user ceiling caps modeled speed and distance outside ERG", () => {
  const now = telemetry({ power: 5000, speed: 40, start: 40 });
  state.maxRideSpeedKph = 32;
  const result = advanceRealRoadSpeed(1, 0, now);
  assert.equal(result.speedKph, 32);
  assert.ok(result.distanceMeters <= 32 / 3.6 + 1e-8);
  assert.equal(state.roadSpeedLimited, true);
  assert.ok(state.trainerBrakeStrength > 0);
});

test("modeled braking is independent of raw overspeed once the trainer is engaged", () => {
  const brakes = [];
  for (const speed of [32, 50, 100]) {
    const now = telemetry({ power: 5000, speed, start: 32 });
    state.maxRideSpeedKph = 32;
    advanceRealRoadSpeed(1, 0, now);
    brakes.push(state.trainerBrakeStrength);
  }
  assert.ok(brakes[0] > 0);
  assert.equal(brakes[0], brakes[1]);
  assert.equal(brakes[0], brakes[2]);
});

test("ERG bypasses the ceiling and extra braking while using measured power", () => {
  const now = telemetry({ erg: true, power: 1000, speed: 0, start: 90 });
  state.maxRideSpeedKph = 15;
  assert.ok(advanceRealRoadSpeed(1, -10, now).speedKph > 72);
  assert.equal(state.roadSpeedLimited, false);
  assert.equal(state.trainerBrakeStrength, 0);
});

test("the road-load ramp does not attenuate measured power or change modeled motion", () => {
  const now = telemetry({ power: 0, cadence: 0, speed: 100 });
  prepareRealRoadMotion(trainerEffort(now));
  assert.equal(state.trainerLoadFraction, 0);
  state.trainerPowerWatts = 200;
  state.trainerSpeedKph = 30;
  const expected = advanceCyclingMotion(30, 200, 0, 0.5, { ...realRoadConfig(), max_speed_kph: Infinity });
  assert.deepEqual(advanceRealRoadSpeed(0.5, 0, now), expected);
  assert.ok(state.trainerLoadFraction > 0 && state.trainerLoadFraction < 1);
});

test("real road speed brakes before a GPX bend and corner braking can be disabled", () => {
  const now = telemetry({ speed: 0, start: 60 });
  const point = (x, y) => ({ ...destinationPoint(destinationPoint({ lat: 50, lng: 14 }, 90, x), 0, y), ele: 100 });
  const route = enrichRoute([...Array.from({ length: 61 }, (_, i) => point(i * 5, 0)), ...Array.from({ length: 60 }, (_, i) => point(300, (i + 1) * 5))]);
  state.route = route;
  state.progressMeters = 280;
  assert.ok(advanceRealRoadSpeed(0.5, 0, now).speedKph < 50);
  telemetry({ speed: 100, start: 60 });
  state.route = route;
  state.progressMeters = 280;
  state.autoCornerBraking = false;
  const expected = advanceCyclingMotion(60, 200, 0, 0.5, { ...realRoadConfig(), max_speed_kph: Infinity });
  assert.deepEqual(advanceRealRoadSpeed(0.5, 0, now), expected);
});

test("finish rollout remains independent of telemetry and does not advance route progress", () => {
  telemetry();
  finishRoadMotion();
  const expected = advanceCyclingMotion(30, 0, 0, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
  state.trainerSpeedKph = 100;
  state.trainerPowerWatts = 1000;
  advanceFinishedRoadSpeed(1);
  assert.equal(state.roadSpeedKph, expected.speedKph);
  assert.equal(state.progressMeters, 0);
  for (let i = 0; i < 300; i++) advanceFinishedRoadSpeed(1);
  assert.equal(state.roadSpeedKph, 0);
  resetRoadMotion();
  assert.equal(state.roadFinished, false);
});

test("simulation finishes coast with the simulated athlete mass and preserve hardware telemetry", () => {
  telemetry({ speed: 80, power: 1000 });
  const config = { ...realRoadConfig(), rider_weight_kg: 55 };
  finishRoadMotion({ config, model: { speedKph: 30 } });
  advanceFinishedRoadSpeed(1);
  const expected = advanceCyclingMotion(30, 0, 0, 1, { ...config, max_speed_kph: Infinity });
  assert.equal(state.roadSpeedKph, expected.speedKph);
  assert.equal(state.trainerSpeedKph, 80);
  assert.equal(state.trainerPowerWatts, 1000);
  resetRoadMotion();
});


test("fresh zero watts slows an uphill rider to rest without reversing", () => {
  const now = telemetry({ power: 0, cadence: 0, speed: 100 });
  let distance = 0;
  for (let i = 0; i < 60; i++) {
    const motion = advanceRealRoadSpeed(1, 5, now);
    assert.ok(motion.speedKph >= 0 && motion.distanceMeters >= 0);
    distance += motion.distanceMeters;
  }
  assert.ok(distance > 0);
  assert.equal(state.roadSpeedKph, 0);
  assert.equal(realRoadMoving(), false);
  assert.deepEqual(advanceRealRoadSpeed(1, 5, now), { speedKph: 0, distanceMeters: 0 });
});

test("fresh zero watts preserves downhill coasting and later rolls to rest on flat ground", () => {
  const now = telemetry({ power: 0, cadence: 0, speed: 0 });
  for (let i = 0; i < 10; i++) advanceRealRoadSpeed(1, -5, now);
  assert.ok(state.roadSpeedKph > 30);
  assert.equal(realRoadMoving(), true);
  const before = state.roadSpeedKph;
  const flat = advanceRealRoadSpeed(1, 0, now);
  assert.ok(flat.speedKph < before && flat.speedKph > 0);
  for (let i = 0; i < 180; i++) advanceRealRoadSpeed(1, 0, now);
  assert.equal(state.roadSpeedKph, 0);
  assert.equal(realRoadMoving(), false);
});

test("virtual, ERG, and ordinary rides agree over time at matched power, mass, grade, and limits", async () => {
  const { advanceDemoRide, createDemoRideModel, simulationAthlete } = await import("../app/demo/demo.mjs");
  for (const [grade, power] of [[5, 200], [5, 800], [0, 200], [-5, 200], [-5, 0]]) {
    const config = { ...simulationAthlete("advanced"), ...ROAD_PHYSICS, inertia_enabled: true };
    const virtual = createDemoRideModel(config);
    virtual.speedKph = 30;
    let virtualDistance = 0;
    for (let i = 0; i < 100; i++) {
      advanceDemoRide(virtual, { elapsedSeconds: 0.02, gradePercent: grade, targetPowerWatts: power, config });
      virtualDistance += virtual.distanceMetersAdvanced;
    }
    for (const erg of [false, true]) {
      const now = telemetry({ power, erg, speed: 100 });
      let actualDistance = 0;
      for (let i = 0; i < 100; i++) actualDistance += advanceRealRoadSpeed(0.02, grade, now).distanceMeters;
      assert.equal(state.roadSpeedKph, virtual.speedKph);
      assert.equal(actualDistance, virtualDistance);
    }
  }
});

test("descent catch-up stays unloaded until fresh trainer speed matches road speed", () => {
  const now = telemetry({ power: 200, speed: 20, start: 60 });
  advanceRealRoadSpeed(1, -15, now);
  assert.equal(state.trainerLoadFraction, 0);
  state.trainerSpeedKph = 65;
  advanceRealRoadSpeed(0.5, -15, now);
  assert.ok(state.trainerLoadFraction > 0);
});

test("uphill road-speed loss adds hardware compensation without adding virtual forces", () => {
  const now = telemetry({ power: 200, speed: 30, start: 20 });
  const expected = advanceCyclingMotion(20, 200, 15, 1, realRoadConfig());
  assert.deepEqual(advanceRealRoadSpeed(1, 15, now), expected);
  assert.ok(state.trainerUphillGradePercent > 0);
});


test("stale trainer speed unloads hardware while fresh power keeps road motion valid", () => {
  const now = telemetry({ power: 200, speed: 30, start: 20 });
  state.trainerSpeedSampleAt = now - ROAD_PHYSICS.telemetry_timeout_ms - 1;
  const expected = advanceCyclingMotion(20, 200, 15, 1, realRoadConfig());
  assert.deepEqual(advanceRealRoadSpeed(1, 15, now), expected);
  assert.equal(state.trainerLoadFraction, 0);
  assert.equal(state.trainerUphillGradePercent, 0);
});

test("ERG and disabled inertia never add uphill speed compensation", () => {
  for (const options of [{ erg: true }, { inertia: false }]) {
    const now = telemetry({ power: 200, speed: 100, start: 20, ...options });
    state.trainerUphillGradePercent = 5;
    advanceRealRoadSpeed(1, 15, now);
    assert.equal(state.trainerUphillGradePercent, 0);
    assert.equal(state.trainerLoadFraction, 1);
  }
});
