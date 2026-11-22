import test from "node:test";
import assert from "node:assert/strict";
import { advanceRoadLoad } from "../app/trainer/load-ramp.mjs";
import { ROAD_PHYSICS as config } from "../app/core/tuning.mjs";

const initial = { fraction: 1, uphillGradePercent: 0 };
const sample = (overrides = {}) => ({ powerWatts: 200, trainerSpeedKph: 30, roadSpeedKph: 30, gradePercent: 0, ...overrides });

test("catching up keeps minimum load regardless of effort or elapsed time", () => {
  for (const powerWatts of [20, 200, 2000]) {
    assert.deepEqual(advanceRoadLoad(initial, sample({ powerWatts, trainerSpeedKph: 20, roadSpeedKph: 60, gradePercent: -15 }), 10, config), { fraction: 0, uphillGradePercent: 0 });
  }
});

test("matching speed restores load gradually and falling behind unloads again", () => {
  let load = { fraction: 0, uphillGradePercent: 0 };
  for (let i = 0; i < 3; i++) load = advanceRoadLoad(load, sample(), 0.5, config);
  assert.equal(load.fraction, 1);
  assert.equal(advanceRoadLoad(load, sample({ trainerSpeedKph: 20 }), 1, config).fraction, 0);
});

test("speed hysteresis prevents repeated disengagement near matching speeds", () => {
  const ramp = advanceRoadLoad({ ...initial, fraction: 0 }, sample({ trainerSpeedKph: 29.6 }), 0.1, config);
  assert.ok(ramp.fraction > 0);
  assert.ok(advanceRoadLoad(ramp, sample({ trainerSpeedKph: 29 }), 0.1, config).fraction > ramp.fraction);
  assert.equal(advanceRoadLoad({ ...initial, fraction: 0 }, sample({ trainerSpeedKph: 29 }), 0.1, config).fraction, 0);
});

test("missing speed and near-zero power release both load and compensation", () => {
  for (const overrides of [{ trainerSpeedKph: null }, { trainerSpeedKph: NaN }, { powerWatts: 0 }, { powerWatts: null }]) {
    assert.deepEqual(advanceRoadLoad({ fraction: 1, uphillGradePercent: 5 }, sample(overrides), 1, config), { fraction: 0, uphillGradePercent: 0 });
  }
});

test("uphill speed deficit increases bounded resistance without changing road motion", () => {
  const matched = advanceRoadLoad(initial, sample({ gradePercent: 15 }), 1, config);
  const behind = advanceRoadLoad(initial, sample({ gradePercent: 15, roadSpeedKph: 20 }), 1, config);
  const stopped = advanceRoadLoad(initial, sample({ gradePercent: 15, roadSpeedKph: 0 }), 1, config);
  assert.equal(matched.uphillGradePercent, 0);
  assert.ok(behind.uphillGradePercent > 0);
  assert.ok(stopped.uphillGradePercent >= behind.uphillGradePercent);
  assert.ok(stopped.uphillGradePercent <= config.trainer_uphill_max_grade_percent);
  assert.ok(behind.uphillGradePercent <= config.trainer_uphill_grade_rate_per_second);
});

test("compensation releases gradually at matching speed and never adds downhill load", () => {
  const previous = { fraction: 1, uphillGradePercent: 5 };
  const released = advanceRoadLoad(previous, sample({ gradePercent: 15 }), 0.1, config);
  assert.ok(released.uphillGradePercent < 5 && released.uphillGradePercent > 0);
  assert.equal(advanceRoadLoad(previous, sample({ gradePercent: -15 }), 1, config).uphillGradePercent, 0);
});
