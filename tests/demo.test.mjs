import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceDemoRide,
  createDemoRideModel,
  demoSpeedForPower,
  demoTargetCadenceRpm,
  demoTargetPowerWatts,
  simulationAthlete,
} from "../app/demo/demo.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";
import { advanceCyclingMotion } from "../app/ride/cycling-motion.mjs";
import { cyclingPowerForSpeed } from "../app/ride/cycling-speed.mjs";
import { activeCaloriesFromPower } from "../app/core/units.mjs";
import { CYCLING_GROSS_EFFICIENCY } from "../app/core/tuning.mjs";

test("fixed speed honors the hard ceiling and estimates power at the limited speed", () => {
  const config = { ...TEST_RIDE, ...ROAD_PHYSICS, max_speed_kph: 30 };
  const model = createDemoRideModel(config);
  const telemetry = advanceDemoRide(model, { elapsedSeconds: 1, gradePercent: 0, fixedSpeedKph: 100, config });
  assert.equal(telemetry.speedKph, 30);
  assert.equal(model.powerWatts, cyclingPowerForSpeed(30, 0, config));
  assert.equal(model.caloriesKcal, activeCaloriesFromPower(model.powerWatts, 1, CYCLING_GROSS_EFFICIENCY));
  assert.ok(model.distanceMetersAdvanced <= 30 / 3.6 + 1e-8);
});

test("fixed and power-driven simulations share corner braking when the limiter is enabled", () => {
  const profile = [{ distanceMeters: 0, speedSquared: (20 / 3.6) ** 2 }, { distanceMeters: 1000, speedSquared: (20 / 3.6) ** 2 }];
  for (const inertia of [true, false]) for (const fixed of [null, 60]) {
    const config = { ...TEST_RIDE, ...ROAD_PHYSICS, inertia_enabled: inertia };
    const model = createDemoRideModel(config);
    model.speedKph = 60;
    const telemetry = advanceDemoRide(model, { elapsedSeconds: 1, gradePercent: -10, targetPowerWatts: 500, fixedSpeedKph: fixed,
      speedLimits: { profile, roadMeters: 0, config: { max_speed_kph: 72, integration_step_seconds: 0.02, recovery_acceleration_mps2: 1 } }, config });
    assert.ok(telemetry.speedKph <= 20 + 1e-7, telemetry.speedKph);
    assert.ok(model.distanceMetersAdvanced <= 20 / 3.6 + 1e-7);
  }
});

test("simulated ERG can bypass both the ceiling and corner envelope", () => {
  const config = { ...TEST_RIDE, ...ROAD_PHYSICS, max_speed_kph: Infinity };
  for (const inertia of [true, false]) {
    const model = createDemoRideModel(config);
    model.speedKph = 90;
    model.speedLimited = true;
    const telemetry = advanceDemoRide(model, { elapsedSeconds: 1, gradePercent: -10, targetPowerWatts: 1000,
      speedLimits: false, config: { ...config, inertia_enabled: inertia } });
    assert.ok(Number.isFinite(telemetry.speedKph) && telemetry.speedKph > 72, String(telemetry.speedKph));
    assert.equal(model.speedLimited, false);
  }
});

test("virtual and ERG motion share the same integrator and can coast at zero watts", () => {
  const config = { ...TEST_RIDE, ...ROAD_PHYSICS, min_power_watts: 0 };
  const model = createDemoRideModel(config);
  model.speedKph = 30;
  const expected = advanceCyclingMotion(30, 0, -8, 1, config);
  const telemetry = advanceDemoRide(model, { elapsedSeconds: 1, gradePercent: -8, targetPowerWatts: 0, config });
  assert.equal(model.speedKph, expected.speedKph);
  assert.equal(model.distanceMetersAdvanced, expected.distanceMeters);
  assert.equal(telemetry.cadenceRpm, 0);
  assert.ok(Number.isFinite(model.cadenceRpm));
});

test("simulation ends at the distance boundary without consuming the full tick", () => {
  const config = { ...TEST_RIDE, ...ROAD_PHYSICS };
  const model = createDemoRideModel(config);
  model.speedKph = 30;
  advanceDemoRide(model, { elapsedSeconds: 5, gradePercent: -8, targetPowerWatts: 200, maxDistanceMeters: 1, config });
  assert.ok(Math.abs(model.distanceMetersAdvanced - 1) < 1e-7);
  assert.ok(model.elapsedSeconds > 0 && model.elapsedSeconds < 0.2);
});

test("a simulation exposes the consumed slice without subtracting cumulative clocks", () => {
  const config = { ...TEST_RIDE, ...ROAD_PHYSICS };
  const model = createDemoRideModel(config);
  model.elapsedSeconds = 10000;
  advanceDemoRide(model, { elapsedSeconds: 1 / 60, gradePercent: 0, config });
  assert.equal(model.elapsedSecondsAdvanced, 1 / 60);
  // This difference loses precision and must never drive the slice loop.
  assert.notEqual(model.elapsedSeconds - 10000, model.elapsedSecondsAdvanced);
});

// A pinned rider profile so the tests exercise the physics/HR model, never
// the shipped DEMO_RIDE tuning — retuning demo mode must not break this suite.
const TEST_RIDE = {
  rider_weight_kg: 100,
  bike_weight_kg: 9,
  ftp_watts: 270,
  max_heart_rate_bpm: 180,
  resting_heart_rate_bpm: 86,
  threshold_heart_rate_bpm: 155,
  flat_power_watts: 205,
  climb_watts_per_grade_percent: 13.5,
  descent_watts_per_grade_percent: 24,
  min_power_watts: 85,
  max_power_watts: 360,
  power_smoothing_tau_seconds: 7,
  flat_cadence_rpm: 88,
  cadence_rpm_per_grade_percent: -1.5,
  cadence_power_exponent: 0.25,
  min_cadence_rpm: 55,
  max_cadence_rpm: 105,
  cadence_smoothing_tau_seconds: 5,
  cadence_noise_rpm: 2,
  rolling_resistance_coefficient: 0.005,
  drag_area_square_meters: 0.48,
  air_density_kg_per_cubic_meter: 1.225,
  drivetrain_efficiency: 0.96,
  min_speed_kph: 5,
  max_speed_kph: 72,
  speed_smoothing_tau_seconds: 5,
  heart_rate_update_interval_seconds: 1,
  heart_rate_rise_tau_seconds: 30,
  heart_rate_fall_delay_seconds: 16,
  heart_rate_fall_tau_seconds: 78,
  low_effort_return_delay_seconds: 120,
  heart_rate_noise_bpm: 1,
};

test("demo target power rises on climbs and backs off on descents", () => {
  assert.ok(demoTargetPowerWatts(7, TEST_RIDE) > demoTargetPowerWatts(0, TEST_RIDE));
  assert.ok(demoTargetPowerWatts(-5, TEST_RIDE) < demoTargetPowerWatts(0, TEST_RIDE));
});

test("demo target cadence drops on climbs and rises on descents, within bounds", () => {
  const flat = demoTargetCadenceRpm(0, TEST_RIDE);
  const climb = demoTargetCadenceRpm(8, TEST_RIDE);
  const descent = demoTargetCadenceRpm(-5, TEST_RIDE);

  assert.ok(climb < flat, `${climb} rpm should be lower than ${flat} rpm`);
  assert.ok(descent > flat, `${descent} rpm should be higher than ${flat} rpm`);
  assert.ok(demoTargetCadenceRpm(50, TEST_RIDE) >= TEST_RIDE.min_cadence_rpm);
  assert.ok(demoTargetCadenceRpm(-50, TEST_RIDE) <= TEST_RIDE.max_cadence_rpm);
});

test("demo speed solve slows uphill and speeds downhill at the same power", () => {
  const flat = demoSpeedForPower(220, 0, TEST_RIDE);
  const climb = demoSpeedForPower(220, 8, TEST_RIDE);
  const descent = demoSpeedForPower(220, -5, TEST_RIDE);

  assert.ok(climb < flat, `${climb} kph should be slower than ${flat} kph`);
  assert.ok(descent > flat, `${descent} kph should be faster than ${flat} kph`);
});

test("demo heart rate settles near threshold HR at FTP power", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const config = { ...TEST_RIDE, flat_power_watts: TEST_RIDE.ftp_watts };
    const model = createDemoRideModel(config);

    for (let i = 0; i < 240; i += 1) {
      advanceDemoRide(model, {
        elapsedSeconds: 1,
        gradePercent: 0,
        config,
      });
    }

    assert.ok(Math.abs(model.heartRateBpm - TEST_RIDE.threshold_heart_rate_bpm) <= 3);
  } finally {
    Math.random = originalRandom;
  }
});

test("demo heart rate publishes at most once a second", () => {
  const originalRandom = Math.random;
  let randomValue = 0.9;
  Math.random = () => randomValue;
  try {
    const model = createDemoRideModel(TEST_RIDE);
    advanceDemoRide(model, {
      elapsedSeconds: 1,
      gradePercent: 0,
      config: TEST_RIDE,
    });
    const first = model.heartRateBpm;
    randomValue = 0.1;
    advanceDemoRide(model, {
      elapsedSeconds: 0.25,
      gradePercent: 8,
      config: TEST_RIDE,
    });

    assert.equal(model.heartRateBpm, first);
  } finally {
    Math.random = originalRandom;
  }
});

test("workout power overrides grade-based power, including a zero-watt target", () => {
  const model = createDemoRideModel(TEST_RIDE);
  const telemetry = advanceDemoRide(model, {
    elapsedSeconds: 1, gradePercent: 8, targetPowerWatts: 315, config: TEST_RIDE,
  });
  assert.equal(telemetry.powerWatts, 315);
  const calories = model.caloriesKcal;
  assert.ok(calories > 0);

  const recovery = advanceDemoRide(model, {
    elapsedSeconds: 1, gradePercent: 8, targetPowerWatts: 0, config: TEST_RIDE,
  });
  assert.equal(recovery.powerWatts, 0);
  assert.equal(recovery.cadenceRpm, 0);
  assert.equal(model.caloriesKcal, calories);

  const freeRide = advanceDemoRide(model, { elapsedSeconds: 1, gradePercent: 8, config: TEST_RIDE });
  assert.ok(freeRide.powerWatts > 0);
});

test("fixed speed uses the required road power and coasts when gravity is enough", () => {
  const model = createDemoRideModel(TEST_RIDE);
  const atSpeed = (grade) => advanceDemoRide(model, {
    elapsedSeconds: 1, gradePercent: grade, fixedSpeedKph: 30, config: TEST_RIDE,
  });
  const flat = atSpeed(0);
  const uphill = atSpeed(6);
  const downhill = atSpeed(-8);
  assert.equal(flat.speedKph, 30);
  assert.ok(flat.powerWatts > 0);
  assert.ok(uphill.powerWatts > flat.powerWatts);
  assert.equal(downhill.speedKph, 30);
  assert.equal(downhill.powerWatts, 0);
  assert.equal(downhill.cadenceRpm, 0);
});

test("athlete profiles change sustainable power and cadence", () => {
  const beginner = simulationAthlete("beginner");
  const elite = simulationAthlete("tour");
  assert.ok(beginner.ftp_watts < elite.ftp_watts);
  assert.ok(demoTargetPowerWatts(4, beginner) < demoTargetPowerWatts(4, elite));
  assert.ok(demoTargetCadenceRpm(4, beginner) < demoTargetCadenceRpm(4, elite));
});
