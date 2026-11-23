import test from "node:test";
import assert from "node:assert/strict";
import { governMotion } from "../app/ride/speed-governor.mjs";

const config = { max_speed_kph: 60, recovery_acceleration_mps2: 1, integration_step_seconds: 0.02 };
const motion = (speed, seconds) => ({ speedKph: speed, distanceMeters: speed / 3.6 * seconds });
const plan = [
  { distanceMeters: 0, speedSquared: 25 ** 2 },
  { distanceMeters: 100, speedSquared: (20 / 3.6) ** 2 },
  { distanceMeters: 150, speedSquared: (20 / 3.6) ** 2 },
  { distanceMeters: 155, speedSquared: 40 ** 2 },
];

test("the hard limit bounds both speed and traveled distance for hardware or fixed-speed input", () => {
  const result = governMotion(false, 100, motion(100, 5), 5, 0, null, config);
  assert.ok(result.speedKph <= 60);
  assert.ok(result.distanceMeters <= 60 / 3.6 * 5 + 1e-8);
});

test("motion under the limit is preserved exactly", () => {
  const source = { speedKph: 29.1, distanceMeters: 8.123 };
  const result = governMotion(false, 30, source, 1, 0, null, config);
  assert.equal(result.speedKph, source.speedKph);
  assert.equal(result.distanceMeters, source.distanceMeters);
  assert.equal(result.limited, false);
});

test("advance braking respects the corner limit even across a long hidden-tab tick", () => {
  const result = governMotion(false, 50, motion(60, 5), 5, 75, plan, config);
  assert.ok(result.limited);
  assert.ok(result.speedKph <= 20 + 1e-6, result.speedKph);
  assert.ok(result.distanceMeters < 60 / 3.6 * 5);
});

test("after a bend the limiter releases speed gradually", () => {
  const result = governMotion(true, 20, motion(60, 1), 1, 180, plan, config);
  assert.ok(result.speedKph <= 23.6 + 1e-7 && result.speedKph > 20, result.speedKph);
});

test("zero-duration setting changes still enforce the hard limit", () => {
  const result = governMotion(false, 90, motion(90, 0), 0, 0, null, config);
  assert.equal(result.speedKph, 60);
  assert.equal(result.distanceMeters, 0);
});
