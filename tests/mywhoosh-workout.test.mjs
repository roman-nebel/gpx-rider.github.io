import { normalizeWorkoutStep } from "../app/workout/workout-step.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeMyWhooshJson } from "../app/workout/mywhoosh-workout.mjs";
import { previewWorkoutStep as previewStep } from "../app/workout/workout-preview.mjs";

function previewWorkoutStep(step, ftp) {
  return previewStep(normalizeWorkoutStep(step), ftp);
}

test("keeps the direction of MyWhoosh power ramps and the cadence target", () => {
  const workout = decodeMyWhooshJson(JSON.stringify({
    Name: "Tempo",
    Mode: "E_Ride",
    WorkoutSteps: [],
    WorkoutStepsArray: [
      { StepType: "E_CoolDown", Time: 360, StartPower: 0.55, EndPower: 0.45, Rpm: 85 },
      { StepType: "E_Normal", Time: 310, Power: 0.8, StartPower: 0, EndPower: 0, Rpm: 95 },
    ],
  }));

  assert.equal(workout.name, "Tempo");
  const [ramp, interval] = workout.steps;
  assert.deepEqual(ramp.power, [0.55, 0.45]);
  assert.equal(previewWorkoutStep(ramp, 200).detail, "6 min · 110 W→90 W · 85 rpm");
  assert.deepEqual(previewWorkoutStep(ramp, null), {
    name: "Cooldown",
    detail: "6 min · Free ride · 85 rpm",
    notes: undefined,
    needsFtp: true,
  });
  assert.equal(previewWorkoutStep(interval, 200).detail, "5 min 10 s · 160 W · 95 rpm");
});

test("rejects a MyWhoosh ramp with a missing endpoint", () => {
  assert.throws(() => decodeMyWhooshJson(JSON.stringify({
    Mode: "E_Ride",
    WorkoutStepsArray: [{ StepType: "E_WarmUp", Time: 480, StartPower: 0.45 }],
  })), /invalid step value/);
});
