import test from "node:test";
import assert from "node:assert/strict";
import { advanceTrainerBrake } from "../app/ride/trainer-braking.mjs";

const config = { trainer_brake_full_overspeed_kph: 10, trainer_brake_speed_deadband_kph: 0.5,
  trainer_brake_release_gap_kph: 1.5, trainer_brake_speed_band_kph: 0.5,
  trainer_brake_engage_seconds: 1.5, trainer_brake_release_seconds: 1, braking_deceleration_mps2: 2 };
const apply = (previous, overrides = {}) => advanceTrainerBrake(previous, {
  erg: false, pedaling: true, loadFraction: 1, speedKph: 40, previousSpeedKph: 40,
  trainerSpeedKph: 60, limitKph: 40, limited: true, elapsedSeconds: 0.1, ...overrides,
}, config);

test("the speed limiter smoothly adds trainer brake load while coupled", () => {
  const first = apply(0);
  assert.ok(first > 0 && first <= 0.1 / 1.5);
  assert.equal(apply(first, { elapsedSeconds: 2 }), 1);
});

test("ERG and an open freewheel always suppress additional braking", () => {
  assert.equal(apply(1, { erg: true }), 0);
  assert.equal(apply(1, { loadFraction: 0 }), 0);
  assert.equal(apply(1, { pedaling: false }), 0);
  assert.equal(apply(1, { trainerSpeedKph: null }), 0);
});

test("recovery after a corner releases brake load instead of resisting acceleration", () => {
  const release = apply(1, { speedKph: 25, previousSpeedKph: 24, limitKph: 72, trainerSpeedKph: 80 });
  assert.ok(release < 1 && release > 0);
  assert.equal(apply(release, { speedKph: 25, limitKph: 72, elapsedSeconds: 2 }), 0);
});

test("braking stays steady near the limit and releases below the hysteresis gap", () => {
  assert.equal(apply(0.5, { trainerSpeedKph: 40, limited: false }), 0.5);
  assert.ok(apply(0.5, { trainerSpeedKph: 38, limited: false }) < 0.5);
});

test("approach deceleration contributes braking even with only a small speed mismatch", () => {
  assert.ok(apply(0, { speedKph: 40, previousSpeedKph: 40.72, trainerSpeedKph: 40.1 }) > 0);
});
