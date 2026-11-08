import assert from "node:assert/strict";
import test from "node:test";
import { fitCrc16 } from "../app/ride/fit.mjs";
import { decodeFitWorkout } from "../app/workout/fit-workout.mjs";
import { previewWorkoutStep } from "../app/workout/workout-preview.mjs";

function workoutFile({ fileType = 5, repeatFrom = 0 } = {}) {
  // Big-endian Workout Step definitions, a developer field, and an optional
  // 12-byte header exercise reader paths the activity exporter does not use.
  const data = [
    0x40, 0, 0, 0, 0, 1, 0, 1, 0,
    0, fileType,
    0x41, 0, 0, 26, 0, 3, 4, 1, 0, 6, 2, 0x84, 8, 5, 7,
    1, 2, 2, 0, 84, 101, 115, 116, 0,
    0x62, 0, 1, 0, 27, 7, 254, 2, 0x84, 1, 1, 0, 2, 4, 0x86,
    3, 1, 0, 4, 4, 0x86, 5, 4, 0x86, 6, 4, 0x86, 1, 0, 2, 0,
    2, 0, 0, 0, 0, 0, 234, 96, 4, 0, 0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 90, 42, 43,
    2, 0, 1, 6, 0, 0, 0, repeatFrom, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 42, 43,
  ];
  const bytes = new Uint8Array(12 + data.length + 2);
  const view = new DataView(bytes.buffer);
  bytes.set([12, 0x20, 0, 0]);
  view.setUint32(4, data.length, true);
  bytes.set([46, 70, 73, 84], 8);
  bytes.set(data, 12);
  view.setUint16(bytes.length - 2, fitCrc16(bytes.subarray(0, -2)), true);
  return bytes.buffer;
}

test("imports FIT Workout steps with a relative power target and a repeat", () => {
  const workout = decodeFitWorkout(workoutFile());
  assert.equal(workout.name, "Test");
  const [interval, repeat] = workout.steps;
  assert.deepEqual(previewWorkoutStep(interval, null), {
    name: "Step",
    detail: "1 min · Free ride",
    notes: undefined,
    needsFtp: true,
  });
  assert.equal(previewWorkoutStep(interval, 250).detail, "1 min · 200 W–225 W");
  assert.equal(previewWorkoutStep(repeat, null).detail, "Repeat count 3");
});

test("keeps absolute power and independent targets when FTP is missing", () => {
  const step = { 1: 5, 3: 4, 5: 1180, 6: 1210, 19: 4, 21: 75, 22: 85 };
  const preview = previewWorkoutStep(step, null);
  assert.equal(preview.detail, "Open duration · 180 W–210 W · Free ride");
  assert.equal(preview.needsFtp, true);
  assert.equal(previewWorkoutStep({ 1: 5, 3: 4, 5: 1180, 6: 1210 }, null).needsFtp, false);
});

test("rejects recorded activities, damaged files, and invalid repeats", () => {
  assert.throws(() => decodeFitWorkout(workoutFile({ fileType: 4 })), /Choose a FIT Workout/);
  assert.throws(() => decodeFitWorkout(workoutFile({ repeatFrom: 1 })), /invalid repeat/);
  const buffer = workoutFile();
  new Uint8Array(buffer)[20] ^= 1;
  assert.throws(() => decodeFitWorkout(buffer), /damaged/);
});
