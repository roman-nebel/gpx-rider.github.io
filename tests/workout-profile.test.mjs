import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkoutProfile } from "../app/workout/workout-profile.mjs";

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
    start: 0, end: 480, power: { start: 65, end: 45, unit: "% FTP", relative: true },
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
