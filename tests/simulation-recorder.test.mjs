import assert from "node:assert/strict";
import test from "node:test";
import {
  createSimulationRecording,
  latestSimulationRecording,
  recordSimulationTick,
  simulationWorkoutFit,
} from "../app/simulation/simulation-recorder.mjs";

test("a short simulation keeps its first and last positions and an empty run preserves it", (context) => {
  const startTimeMs = Date.UTC(2026, 6, 4, 10);
  const recording = createSimulationRecording(startTimeMs);
  const saved = new Map();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem(key, value) { saved.set(key, value); } },
  });
  context.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  });
  const first = {
    point: { lat: 50, lng: 14, ele: 300 },
    routeProgressMeters: 200,
    elapsedSeconds: 0,
    metersAdvanced: 0,
    caloriesKcal: 0,
    telemetry: { speedKph: 36, powerWatts: 240, cadenceRpm: 90, heartRateBpm: 120 },
  };
  recordSimulationTick(recording, first);
  recordSimulationTick(recording, {
    ...first, elapsedSeconds: 0.2, metersAdvanced: 2, routeProgressMeters: 202, caloriesKcal: 0.04,
  });
  recordSimulationTick(recording, {
    ...first, elapsedSeconds: 0.3, metersAdvanced: 1, routeProgressMeters: 203, caloriesKcal: 0.06, final: true,
  });
  assert.deepEqual(recording.samples.map(({ routeProgressMeters, distance }) => [routeProgressMeters, distance]),
    [[200, 0], [203, 3]]);
  assert.equal(recording.summary.endTimeMs, startTimeMs + 300);
  assert.equal(JSON.parse(saved.get("gpx-rider:simulation-log")).simulated, true);

  const empty = createSimulationRecording(startTimeMs + 1000);
  recordSimulationTick(empty, { ...first, final: true });
  assert.equal(latestSimulationRecording(), recording);
});


test("workout-only export stops at the saved workout endpoint after virtual riding continues", () => {
  const recording = createSimulationRecording(10000, { name: "Intervals" });
  const first = { t: 10, distance: 0 };
  const workoutEnd = { t: 12, distance: 20 };
  const replacement = { t: 12, distance: 22 };
  recording.workoutEnd = {
    count: 2,
    lastSample: workoutEnd,
    summary: { ...recording.summary, totalDistanceMeters: 20 },
  };
  recording.samples.push(first, replacement, { t: 13, distance: 30 });
  recording.summary.totalDistanceMeters = 30;

  const output = simulationWorkoutFit(recording);
  assert.deepEqual(output.samples, [first, workoutEnd]);
  assert.equal(output.summary.totalDistanceMeters, 20);
  assert.equal(output.simulated, true);
  assert.equal(recording.samples[1], replacement);
  assert.equal(simulationWorkoutFit(createSimulationRecording(10000)), null);
});
