import test from "node:test";
import assert from "node:assert/strict";
import { enrichRoute } from "../app/route/route.mjs";
import { destinationPoint } from "../app/core/geo.mjs";

// This adapter needs only the state map; no browser features are exercised.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { state } = await import("../app/core/state.mjs");
const { advanceRealRoadSpeed, resetRoadMotion, trainerEffort } = await import("../app/ride/road-speed.mjs");
const { advanceCyclingMotion } = await import("../app/ride/cycling-motion.mjs");
const { realRoadConfig } = await import("../app/ride/road-speed.mjs");

function telemetry({ power = 200, cadence = 85, speed = 30 } = {}) {
  resetRoadMotion();
  Object.assign(state, {
    trainerPowerWatts: power, trainerCadenceRpm: cadence, trainerSpeedKph: speed,
    trainerPowerSampleAt: power === null ? null : 1000,
    trainerCadenceSampleAt: cadence === null ? null : 1000,
    trainerSpeedSampleAt: speed === null ? null : 1000,
    inertiaEnabled: true, workoutErgEnabled: true, workoutErg: null,
    route: [], progressMeters: 0, maxRideSpeedKph: 72, autoCornerBraking: true,
  });
}

test("outside ERG coupled riding follows trainer speed on flats and climbs", () => {
  telemetry();
  for (const grade of [0, 10]) assert.equal(advanceRealRoadSpeed(1, grade, 1000).speedKph, 30);
});

test("trainer speed and distance are capped even with inertia disabled", () => {
  telemetry({ speed: 100 });
  state.inertiaEnabled = false;
  state.maxRideSpeedKph = 32;
  const motion = advanceRealRoadSpeed(1, 0, 1000);
  assert.equal(motion.speedKph, 32);
  assert.ok(motion.distanceMeters <= 32 / 3.6 + 1e-8);
  assert.equal(state.trainerSpeedKph, 100);
});

test("real road speed brakes before a GPX bend and the corner switch can disable it", () => {
  telemetry({ speed: 60 });
  const point = (x, y) => ({ ...destinationPoint(destinationPoint({ lat: 50, lng: 14 }, 90, x), 0, y), ele: 100 });
  state.route = enrichRoute([...Array.from({ length: 61 }, (_, i) => point(i * 5, 0)), ...Array.from({ length: 60 }, (_, i) => point(300, (i + 1) * 5))]);
  state.progressMeters = 280;
  const braking = advanceRealRoadSpeed(0.5, 0, 1000);
  assert.ok(braking.speedKph < 50, braking.speedKph);
  assert.equal(state.trainerSpeedKph, 60);
  state.autoCornerBraking = false;
  resetRoadMotion();
  assert.equal(advanceRealRoadSpeed(0.5, 0, 1000).speedKph, 60);
});

test("coasting retains road speed until the pedaling trainer catches up and load is restored", () => {
  telemetry();
  advanceRealRoadSpeed(1, 0, 1000);
  state.trainerCadenceRpm = 0;
  state.trainerPowerWatts = 0;
  state.trainerSpeedKph = 0;
  const coast = advanceRealRoadSpeed(1, 0, 1000);
  assert.ok(coast.speedKph > 25 && coast.speedKph < 30);
  assert.ok(state.roadCoasting);
  state.trainerCadenceRpm = 85;
  state.trainerPowerWatts = 200;
  state.trainerSpeedKph = 24;
  assert.ok(advanceRealRoadSpeed(0.1, 0, 1000).speedKph > 24);
  assert.equal(state.roadCoupling.loadFraction, 0);
  state.trainerSpeedKph = 30;
  for (let i = 0; i < 25; i++) advanceRealRoadSpeed(0.1, 0, 1000);
  assert.equal(state.roadSpeedKph, 30);
  assert.equal(state.roadCoasting, false);
});

test("ERG and coasting use the same physical integrator", () => {
  telemetry();
  state.workoutErg = { paused: false, targetWatts: 200 };
  state.roadSpeedKph = 30;
  const expected = advanceCyclingMotion(30, 200, 5, 1, realRoadConfig());
  assert.deepEqual(advanceRealRoadSpeed(1, 5, 1000), expected);
});

test("ERG bypasses the user speed ceiling and corner braking", () => {
  telemetry({ power: 1000, speed: 90 });
  state.maxRideSpeedKph = 15;
  state.workoutErg = { paused: false, targetWatts: 1000 };
  state.roadSpeedKph = 90;
  const result = advanceRealRoadSpeed(1, -10, 1000);
  assert.ok(result.speedKph > 72, String(result.speedKph));
  assert.equal(state.roadSpeedLimited, false);
  assert.equal(state.trainerBrakeStrength, 0);
});

test("free-ride steps inside a workout return to trainer speed", () => {
  telemetry();
  state.workoutErg = { paused: false, targetWatts: null };
  assert.equal(advanceRealRoadSpeed(1, 10, 1000).speedKph, 30);
  assert.equal(state.ergRoadSpeedKph, null);
});

test("switching inertia off removes app coasting and uses steady ERG speed", () => {
  telemetry({ power: 0, cadence: 0, speed: 20 });
  state.inertiaEnabled = false;
  assert.equal(advanceRealRoadSpeed(1, 0, 1000).speedKph, 20);
  assert.equal(state.roadCoasting, false);
  state.workoutErg = { paused: false, targetWatts: 200 };
  assert.equal(advanceRealRoadSpeed(1, 10, 1000).speedKph, 0);
});

test("stale samples cannot power motion or restart coasting", () => {
  telemetry();
  assert.equal(trainerEffort(5000).fresh, false);
  assert.deepEqual(advanceRealRoadSpeed(1, -10, 5000), { speedKph: 0, distanceMeters: 0 });
  assert.equal(state.roadSpeedKph, null);
});

test("zero cadence is distinct from missing cadence, with power as fallback", () => {
  telemetry({ cadence: null, power: 0 });
  assert.equal(trainerEffort(1000).active, false);
  state.trainerPowerWatts = 100;
  assert.equal(trainerEffort(1000).active, true);
  state.trainerCadenceRpm = 0;
  state.trainerCadenceSampleAt = 1000;
  assert.equal(trainerEffort(1000).active, false);
});

test("the finish keeps integrating flat-road coast independently of telemetry and without adding distance", async () => {
  telemetry();
  const { finishRoadMotion, advanceFinishedRoadSpeed } = await import("../app/ride/road-speed.mjs");
  state.roadSpeedKph = 30;
  finishRoadMotion();
  assert.equal(state.roadFinished, true);
  const expected = advanceCyclingMotion(30, 0, 0, 1, { ...realRoadConfig(), max_speed_kph: Infinity });
  state.trainerSpeedKph = 100;
  state.trainerPowerWatts = 1000;
  const progress = state.progressMeters;
  advanceFinishedRoadSpeed(1);
  assert.equal(state.roadSpeedKph, expected.speedKph);
  assert.equal(state.progressMeters, progress);
  for (let i = 0; i < 300; i++) advanceFinishedRoadSpeed(1);
  assert.equal(state.roadSpeedKph, 0);
  resetRoadMotion();
  assert.equal(state.roadFinished, false);
});


test("a workout power step cannot select ERG physics while the ERG switch is off", () => {
  telemetry();
  state.workoutErgEnabled = false;
  state.workoutErg = { paused: false, targetWatts: 500 };
  const result = advanceRealRoadSpeed(1, 0, 1000);
  assert.equal(result.speedKph, 30);
  assert.equal(state.ergRoadSpeedKph, null);
});

test("a passive trainer's falling speed does not slow app coasting on a descent", () => {
  telemetry({ power: 150, speed: 30 });
  const first = advanceRealRoadSpeed(1, -8, 1000);
  assert.ok(first.speedKph > 30);
  state.trainerSpeedKph = 15;
  state.trainerPowerWatts = 0;
  // Cadence can lag behind a stopped pedal stroke.
  const second = advanceRealRoadSpeed(1, -8, 1000);
  assert.ok(second.speedKph > first.speedKph);
  assert.equal(state.roadCoasting, true);
  assert.equal(state.roadCoupling.loadFraction, 0);
});


test("simulation finishes coast with the simulated athlete mass and preserve hardware telemetry", async () => {
  telemetry({ speed: 80, power: 1000 });
  const { finishRoadMotion, advanceFinishedRoadSpeed } = await import("../app/ride/road-speed.mjs");
  const config = { ...realRoadConfig(), rider_weight_kg: 55 };
  finishRoadMotion({ config, model: { speedKph: 30 } });
  const expected = advanceCyclingMotion(30, 0, 0, 1, { ...config, max_speed_kph: Infinity });
  advanceFinishedRoadSpeed(1);
  assert.equal(state.roadSpeedKph, expected.speedKph);
  assert.equal(state.trainerSpeedKph, 80);
  assert.equal(state.trainerPowerWatts, 1000);
  resetRoadMotion();
});


test("speed-only telemetry keeps the coupled fallback without assuming independent coasting", () => {
  telemetry({ power: null, cadence: null, speed: 30 });
  const result = advanceRealRoadSpeed(1, -8, 1000);
  assert.equal(result.speedKph, 30);
  assert.equal(state.roadCoupling.phase, "coupled");
});
