import { normalizeWorkoutStep } from "../app/workout/workout-step.mjs";
import { WORKOUT_PROFILE_STEP_LIMIT } from "../app/core/tuning.mjs";
import { previewWorkoutStep } from "../app/workout/workout-preview.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkoutProfile as buildProfile } from "../app/workout/workout-profile.mjs";

function buildWorkoutProfile(steps, ftp) {
  return buildProfile(steps.map(normalizeWorkoutStep), ftp);
}

test("uses time for workout widths and preserves descending ramps without FTP", () => {
  const steps = [
    { durationSeconds: 480, power: [0.65, 0.45] },
    { durationSeconds: 120, power: null },
    { 1: 0, 2: 60000, 3: 4, 5: 1170, 6: 1190 },
  ];
  const profile = buildWorkoutProfile(steps, null);
  assert.equal(profile.extent, 660);
  assert.deepEqual(profile.units, ["% FTP", "W"]);
  assert.deepEqual(profile.intervals[0], {
    start: 0, end: 480, power: { start: 65, end: 45, unit: "% FTP", relative: true, low: undefined, zone: undefined },
  });
  assert.equal(profile.intervals[1].power, null);
  assert.equal(profile.intervals[2].power.low, 170);
  assert.deepEqual(buildWorkoutProfile(steps, 200).units, ["W"]);
});

test("expands counted FIT repeats and uses step order for open-ended workouts", () => {
  const timed = { 1: 0, 2: 60000, 3: 4, 5: 80, 6: 80 };
  const repeat = { 1: 6, 2: 0, 4: 3 };
  const expanded = buildWorkoutProfile([timed, repeat], 200);
  assert.equal(expanded.extent, 180);
  assert.equal(expanded.intervals.length, 3);
  const open = buildWorkoutProfile([timed, { 1: 5, 3: 2 }], 200);
  assert.equal(open.timed, false);
  assert.equal(open.extent, 2);
});

test("a numbered FIT power zone requires FTP in both the list and chart", () => {
  const step = normalizeWorkoutStep({ 1: 0, 2: 60000, 3: 4, 4: 3 });
  assert.equal(previewWorkoutStep(step, null).detail, "1 min · Free ride");
  assert.equal(previewWorkoutStep(step, null).needsFtp, true);
  assert.equal(previewWorkoutStep(step, 200).detail, "1 min · Power Zone 3");
  assert.equal(buildProfile([step], null).intervals[0].power.relative, true);
});

test("limits chart size for timed and open-ended source workouts", () => {
  const step = normalizeWorkoutStep({ 1: 0, 2: 60000, 3: 2 });
  const steps = Array(WORKOUT_PROFILE_STEP_LIMIT + 1).fill(step);
  assert.equal(buildProfile(steps, 200), null);
  steps[0] = normalizeWorkoutStep({ 1: 5, 3: 2 });
  assert.equal(buildProfile(steps, 200), null);
});

test("keeps step order when repeat expansion exceeds the chart limit", () => {
  const step = normalizeWorkoutStep({ 1: 0, 2: 60000, 3: 2 });
  const repeat = normalizeWorkoutStep({ 1: 6, 2: 0, 4: WORKOUT_PROFILE_STEP_LIMIT + 1 });
  const chart = buildProfile([step, repeat], 200);
  assert.equal(chart.timed, false);
  assert.equal(chart.intervals.length, 2);
});
