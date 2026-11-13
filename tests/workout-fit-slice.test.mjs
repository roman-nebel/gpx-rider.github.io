import assert from "node:assert/strict";
import test from "node:test";
import { sliceWorkoutFit, workoutFitRange } from "../app/ride/workout-fit-slice.mjs";

test("workout-only export excludes the warmup and free ride outside the plan", () => {
  const workout = { name: "Intervals", steps: [{}, {}] };
  const workoutLaps = [
    { stepIndex: 0, sampleIndex: 1, startMs: 2000, timerSeconds: 2, distanceMeters: 20, caloriesKcal: 10 },
    { stepIndex: 1, sampleIndex: 2, startMs: 3000, timerSeconds: 3, distanceMeters: 40, caloriesKcal: 20 },
    { stepIndex: null, sampleIndex: 3, startMs: 4000, timerSeconds: 4, distanceMeters: 50, caloriesKcal: 25 },
  ];
  const samples = [20, 40, 50, 60].map((distance, index) => ({ t: index + 2, distance, powerWatts: 100 + index }));
  const range = workoutFitRange(workoutLaps, samples.length);
  const slice = sliceWorkoutFit({ samples, workout, workoutLaps }, range);
  assert.equal(slice.workout, workout);
  assert.deepEqual(slice.samples.map(({ distance, powerWatts }) => [distance, powerWatts]), [[20, 101], [30, 102]]);
  assert.deepEqual(slice.workoutLaps.map(({ stepIndex, timerSeconds }) => [stepIndex, timerSeconds]), [[0, 0], [1, 1]]);
  assert.deepEqual(slice.summary, {
    startTimeMs: 2000, endTimeMs: 4000, totalElapsedSeconds: 2,
    totalTimerSeconds: 2, totalDistanceMeters: 30, totalCalories: 15,
  });
});

test("workout-only export resolves legacy boundaries and supports an ongoing workout", () => {
  const start = { stepIndex: 0, startMs: 2000, timerSeconds: 2, distanceMeters: 20, caloriesKcal: null };
  const samples = [{ t: 2, distance: 20 }, { t: 3, distance: 25 }, { t: 4, distance: 30 }];
  const range = workoutFitRange([start], samples.length, () => 1);
  const slice = sliceWorkoutFit({
    samples, workoutLaps: [start], summary: { totalTimerSeconds: 4, totalDistanceMeters: 30, totalCalories: 20 },
  }, range);
  assert.equal(slice.summary.endTimeMs, 4000);
  assert.equal(slice.summary.totalCalories, null);
  assert.equal(slice.samples.length, 2);
  assert.equal(workoutFitRange([start], 2, () => 1), null);
  assert.equal(workoutFitRange([], samples.length), null);
});

test("workout-only export uses the latest restart and excludes riding between runs", () => {
  const workoutLaps = [
    { stepIndex: 0, startsRun: true },
    { stepIndex: null, endsRun: true },
    { stepIndex: 0, startsRun: true },
    { stepIndex: null },
    { stepIndex: 1 },
    { stepIndex: null, endsRun: true },
  ].map((boundary, index) => ({
    ...boundary, sampleIndex: index * 2, startMs: index * 2000,
    timerSeconds: index * 2, distanceMeters: index * 20, caloriesKcal: index * 2,
  }));
  const samples = Array.from({ length: 12 }, (_, t) => ({ t, distance: t * 10 }));
  const range = workoutFitRange(workoutLaps, samples.length);
  const slice = sliceWorkoutFit({ samples, workoutLaps }, range);
  assert.deepEqual(slice.samples.map(({ t }) => t), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(slice.workoutLaps.map(({ stepIndex }) => stepIndex), [0, null, 1]);
  assert.equal(slice.summary.totalTimerSeconds, 6);
});

test("workout-only export keeps a trailing pause through the explicit end of the run", () => {
  const workoutLaps = [
    { stepIndex: 0, startsRun: true, workoutStartMs: 1800 },
    { stepIndex: null, paused: true },
    { stepIndex: null, endsRun: true },
  ].map((boundary, index) => ({
    ...boundary, sampleIndex: 2 + index * 2, startMs: 2000 + index * 2000,
    timerSeconds: 2 + index * 2, distanceMeters: 20 + index * 20, caloriesKcal: 2 + index * 2,
  }));
  const samples = Array.from({ length: 8 }, (_, t) => ({ t, distance: t * 10 }));
  const range = workoutFitRange(workoutLaps, samples.length);
  const slice = sliceWorkoutFit({ samples, workoutLaps }, range);
  assert.deepEqual(slice.samples.map(({ t }) => t), [2, 3, 4, 5]);
  assert.deepEqual(slice.workoutLaps.map(({ stepIndex, paused }) => [stepIndex, Boolean(paused)]), [[0, false], [null, true]]);
  assert.equal(slice.summary.startTimeMs, 1800);
  assert.equal(slice.summary.endTimeMs, 6000);
  assert.equal(slice.summary.totalTimerSeconds, 4);
});
