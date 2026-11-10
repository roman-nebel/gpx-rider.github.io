import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkoutStep } from "../app/workout/workout-step.mjs";
import {
  createWorkoutSummary,
  finishWorkoutSummary,
  sampleWorkoutSummary,
} from "../app/workout/workout-summary.mjs";

test("weights adherence and averages by workout time and excludes unresolved power targets", () => {
  const summary = createWorkoutSummary();
  const fixed = normalizeWorkoutStep({ 1: 0, 2: 60000, 3: 4, 5: 1190, 6: 1210 });
  const relative = normalizeWorkoutStep({ durationSeconds: 60, power: [0.8] });
  const free = normalizeWorkoutStep({ durationSeconds: 60, power: null });
  sampleWorkoutSummary(summary, fixed, 0, 3, { power: 220, heartRate: 150 });
  sampleWorkoutSummary(summary, fixed, 3, 1, { power: 179, heartRate: 130 });
  sampleWorkoutSummary(summary, relative, 0, 2, { power: 100, heartRate: null, ftp: null });
  sampleWorkoutSummary(summary, free, 0, 2, { power: 0, heartRate: 0 });
  assert.deepEqual(finishWorkoutSummary(summary, [fixed, relative, free]), {
    onTarget: 75, power: 130, heartRate: 145, cadence: null,
  });
});

test("uses the current ramp target and reports cadence when the workout prescribes it", () => {
  const summary = createWorkoutSummary();
  const ramp = normalizeWorkoutStep({ durationSeconds: 100, power: [0.5, 1], cadenceRpm: 90 });
  sampleWorkoutSummary(summary, ramp, 9, 2, { power: 110, cadence: 88, ftp: 200 });
  sampleWorkoutSummary(summary, ramp, 89, 2, { power: 110, cadence: 92, ftp: 200 });
  assert.deepEqual(finishWorkoutSummary(summary, [ramp]), {
    onTarget: 50, power: 110, heartRate: null, cadence: 90,
  });
});
