import test from "node:test";
import assert from "node:assert/strict";
import { cyclingForces, advanceCyclingMotion } from "../app/ride/cycling-motion.mjs";

const config = {
  rider_weight_kg: 80, bike_weight_kg: 10,
  rolling_resistance_coefficient: 0.005, drag_area_square_meters: 0.48,
  air_density_kg_per_cubic_meter: 1.225, drivetrain_efficiency: 0.96,
  wind_speed_mps: 0, max_speed_kph: 120,
  integration_step_seconds: 0.02, launch_speed_mps: 0.5,
};

test("flat road load contains rolling resistance and quadratic aerodynamic drag", () => {
  const slow = cyclingForces(18, 0, config);
  const fast = cyclingForces(36, 0, config);
  assert.equal(slow.gravityNewtons, 0);
  assert.ok(Math.abs(slow.rollingNewtons - 90 * 9.80665 * 0.005) < 1e-10);
  assert.equal(fast.dragNewtons, slow.dragNewtons * 4);
});

test("coasting loses speed on the flat, gains it downhill, and can stop uphill", () => {
  const run = (grade) => advanceCyclingMotion(30, 0, grade, 10, config);
  assert.ok(run(0).speedKph < 30);
  assert.ok(run(-8).speedKph > 30);
  assert.equal(run(10).speedKph, 0);
  assert.ok(run(10).distanceMeters > 0);
});

test("gravity uses the slope angle and zero-resistance motion follows Newton's law", () => {
  const free = { ...config, rolling_resistance_coefficient: 0, drag_area_square_meters: 0 };
  const grade = -10;
  const a = 9.80665 * 0.1 / Math.hypot(1, 0.1);
  const result = advanceCyclingMotion(0, 0, grade, 2, free);
  assert.ok(Math.abs(result.speedKph / 3.6 - a * 2) < 1e-8);
  assert.ok(Math.abs(result.distanceMeters - 0.5 * a * 4) < 1e-8);
});

test("powered motion starts at rest and keeps its speed through a grade change", () => {
  const start = advanceCyclingMotion(0, 200, 0, 1, config);
  assert.ok(start.speedKph > 0 && start.speedKph < 15);
  const hill = advanceCyclingMotion(40, 200, 10, 0.02, config);
  assert.ok(hill.speedKph > 39 && hill.speedKph < 40);
});

test("the same elapsed time gives consistent motion across tick rates", () => {
  const single = advanceCyclingMotion(30, 150, 4, 2, config);
  let speed = 30;
  let distance = 0;
  for (let i = 0; i < 120; i++) {
    const step = advanceCyclingMotion(speed, 150, 4, 1 / 60, config);
    speed = step.speedKph;
    distance += step.distanceMeters;
  }
  assert.ok(Math.abs(speed - single.speedKph) < 0.02);
  assert.ok(Math.abs(distance - single.distanceMeters) < 0.02);
});

test("mass affects acceleration and coasting without creating a minimum speed", () => {
  const light = advanceCyclingMotion(0, 200, 0, 1, config);
  const heavy = advanceCyclingMotion(0, 200, 0, 1, { ...config, rider_weight_kg: 160 });
  assert.ok(light.speedKph > heavy.speedKph);
  assert.deepEqual(advanceCyclingMotion(0, 0, 0, 1, config), { speedKph: 0, distanceMeters: 0 });
});
