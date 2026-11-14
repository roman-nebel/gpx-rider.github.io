// Stores the latest simulated activity in its own FIT recording buffer.

import { roundCoordinate } from "../core/geo.mjs";
import { RIDE_PERSIST_INTERVAL_MS, RIDE_SAMPLE_INTERVAL_MS } from "../core/tuning.mjs";
import { readJson, removeStored, writeJson } from "../storage/storage.mjs";

const STORAGE_KEY = "gpx-rider:simulation-log";

let recording = null;
let lastPersistAt = 0;

export function restoreSimulationRecording() {
  const saved = readJson(STORAGE_KEY);
  if (saved?.samples?.length) recording = saved;
}

export function createSimulationRecording(startTimeMs, workout = null) {
  return {
    samples: [],
    simulated: true,
    workout,
    summary: {
      startTimeMs,
      endTimeMs: startTimeMs,
      totalElapsedSeconds: 0,
      totalTimerSeconds: 0,
      totalDistanceMeters: 0,
      totalCalories: 0,
    },
  };
}

export function recordSimulationTick(activity, {
  point, routeProgressMeters, metersAdvanced, telemetry, elapsedSeconds, caloriesKcal, final = false,
}) {
  const { samples, summary } = activity;
  summary.totalTimerSeconds = elapsedSeconds;
  summary.totalElapsedSeconds = elapsedSeconds;
  summary.endTimeMs = summary.startTimeMs + elapsedSeconds * 1000;
  summary.totalDistanceMeters += metersAdvanced;
  summary.totalCalories = caloriesKcal;
  if (summary.totalDistanceMeters > 0) recording = activity;

  const last = samples.at(-1);
  const t = Math.round(summary.endTimeMs / 1000);
  if (final || !last || summary.endTimeMs - activity.lastSampleTimeMs >= RIDE_SAMPLE_INTERVAL_MS) {
    const sample = {
      t,
      lat: roundCoordinate(point.lat),
      lng: roundCoordinate(point.lng),
      ele: point.ele,
      distance: summary.totalDistanceMeters,
      ...telemetry,
      routeProgressMeters,
    };
    if (last?.t === t && samples.length > 1) samples[samples.length - 1] = sample;
    else if (last?.t !== t || summary.totalDistanceMeters > 0) samples.push(sample);
    activity.lastSampleTimeMs = summary.endTimeMs;
  }

  if (recording === activity && summary.endTimeMs - lastPersistAt >= RIDE_PERSIST_INTERVAL_MS) {
    persistSimulationRecording();
  }
}

export function persistSimulationRecording() {
  if (!recording) return;
  const endTimeMs = recording.summary.endTimeMs;
  lastPersistAt = endTimeMs;
  writeJson(STORAGE_KEY, recording);
}

export function latestSimulationRecording() {
  return recording;
}

export async function clearSimulationRecording() {
  const previous = recording;
  recording = null;
  try {
    if (await removeStored(STORAGE_KEY) === false) {
      throw new Error("Could not delete the stored simulation recording.");
    }
  } catch (error) {
    recording ??= previous;
    throw error;
  }
}

export function hasSimulationWorkout(recording) {
  return Boolean(recording?.workout && (recording.workoutEnd?.count ?? recording.samples.length) >= 2);
}

export function simulationWorkoutFit(recording) {
  if (!hasSimulationWorkout(recording)) return null;
  const end = recording.workoutEnd;
  if (!end) return recording;
  // A later free-ride sample can replace the boundary sample at the same
  // FIT timestamp. Retain the original workout endpoint for this export.
  const samples = recording.samples.slice(0, end.count - 1);
  samples.push(end.lastSample);
  return { ...recording, samples, summary: end.summary };
}
