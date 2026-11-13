// Ride recorder — the "bucket" of collected ride data. While the rider is
// moving (pedaling or simulating) the app feeds it ticks; roughly once a
// second it appends a track sample, and every few seconds it persists the
// whole log via storage.mjs (IndexedDB) so a reload or crash never loses a
// ride.

import { roundCoordinate } from "../core/geo.mjs";
import { readJson, removeStored, writeJson } from "../storage/storage.mjs";
import { RIDE_PERSIST_INTERVAL_MS, RIDE_SAMPLE_INTERVAL_MS } from "../core/tuning.mjs";
import { workoutFitRange } from "./workout-fit-slice.mjs";

const RIDE_LOG_STORAGE_KEY = "gpx-rider:ride-log";

// Samples are stored as compact arrays to keep the persisted log small:
// [unixSeconds, lat, lng, ele, distanceMeters, speedKph, powerWatts, heartRateBpm, caloriesKcal, routeProgressMeters, cadenceRpm]
const log = emptyLog();

function emptyLog() {
  return {
    startedAtMs: null,
    timerSeconds: 0,
    distanceMeters: 0,
    samples: [],
    workout: null,
    workoutLaps: [],
    selectedWorkout: null,
    matchesWorkout: false,
    workoutSession: null,
    workoutStep: null,
    lastTickAtMs: null,
    lastTickCalories: null,
    lastSampleAtMs: 0,
    lastPersistAtMs: 0,
    persistBroken: false,
  };
}

export function restoreRideLog() {
  const saved = readJson(RIDE_LOG_STORAGE_KEY);
  if (!saved?.samples?.length) return;

  log.startedAtMs = Number(saved.startedAtMs) || saved.samples[0][0] * 1000;
  log.timerSeconds = Number(saved.timerSeconds) || 0;
  log.distanceMeters = Number(saved.distanceMeters) || 0;
  log.samples = saved.samples.filter(Array.isArray);
  log.workout = saved.workout ?? null;
  log.workoutLaps = saved.workoutLaps ?? [];
  const lastSample = log.samples.at(-1);
  log.lastTickAtMs = saved.lastTickAtMs ?? (lastSample ? lastSample[0] * 1000 : null);
  log.lastTickCalories = Object.hasOwn(saved, "lastTickCalories") ? saved.lastTickCalories : lastSample?.[8] ?? null;
  const lastRunBoundary = log.workoutLaps.findLast(({ startsRun, endsRun }) => startsRun || endsRun);
  if (lastRunBoundary?.startsRun && log.lastTickAtMs !== null) {
    appendWorkoutBoundary(null, log.lastTickAtMs, { endsRun: true });
  }
}

export function recordRideTick({
  elapsedSeconds,
  metersAdvanced,
  point,
  speedKph,
  powerWatts,
  heartRateBpm,
  caloriesKcal,
  routeProgressMeters,
  cadenceRpm,
  workout,
  workoutSession,
  workoutPaused = workoutSession?.paused === true,
}) {
  const now = Date.now();
  if (log.startedAtMs === null) log.startedAtMs = now;
  const lapChanged = recordWorkoutBoundary(workout, workoutSession, workoutPaused, now - elapsedSeconds * 1000);
  log.timerSeconds += Math.max(0, elapsedSeconds);
  log.distanceMeters += Math.max(0, metersAdvanced);
  log.lastTickAtMs = now;
  log.lastTickCalories = Number.isFinite(caloriesKcal) ? caloriesKcal : null;

  if (!lapChanged && now - log.lastSampleAtMs < RIDE_SAMPLE_INTERVAL_MS) return;
  log.lastSampleAtMs = now;

  log.samples.push([
    Math.round(now / 1000),
    roundCoordinate(point.lat),
    roundCoordinate(point.lng),
    Math.round((point.ele ?? 0) * 10) / 10,
    Math.round(log.distanceMeters * 10) / 10,
    Number.isFinite(speedKph) ? Math.round(speedKph * 10) / 10 : null,
    Number.isFinite(powerWatts) ? Math.round(powerWatts) : null,
    Number.isFinite(heartRateBpm) ? Math.round(heartRateBpm) : null,
    Number.isFinite(caloriesKcal) ? Math.round(caloriesKcal) : null,
    Number.isFinite(routeProgressMeters) ? Math.round(routeProgressMeters * 10) / 10 : null,
    Number.isFinite(cadenceRpm) ? Math.round(cadenceRpm) : null,
  ]);

  if (lapChanged || now - log.lastPersistAtMs >= RIDE_PERSIST_INTERVAL_MS) persistRideLog();
}

function recordWorkoutBoundary(workout, session, workoutPaused, startMs) {
  if (workout !== log.selectedWorkout) {
    log.selectedWorkout = workout;
    // FIT Activity has room for one plan. Keep the one that owns recorded laps.
    if (workout && !log.workoutLaps.length) log.workout = workout;
    log.matchesWorkout = Boolean(workout) && (log.workout === workout ||
      JSON.stringify(log.workout) === JSON.stringify(workout));
  }
  const activeSession = log.matchesWorkout ? session ?? null : null;
  const paused = Boolean(activeSession && workoutPaused);
  const step = paused ? null : activeSession?.index ?? null;
  const startsRun = Boolean(activeSession && activeSession !== log.workoutSession);
  const previous = log.workoutLaps.at(-1);
  if (!startsRun && step === log.workoutStep &&
      (step !== null || previous?.stepIndex == null)) return false;

  if (startsRun) log.workoutSession = activeSession;
  log.workoutStep = step;
  appendWorkoutBoundary(activeSession?.steps[step]?.sourceIndex ?? null,
    activeSession ? Math.max(startMs, activeSession.startedAtMs ?? startMs) : log.lastTickAtMs ?? startMs,
    { startsRun, paused, workoutStartMs: startsRun ? activeSession.startedAtMs : undefined });
  return true;
}

function appendWorkoutBoundary(stepIndex, startMs, details = {}) {
  log.workoutLaps.push({
    stepIndex,
    ...details,
    sampleIndex: log.samples.length,
    startMs: Math.max(log.startedAtMs, startMs),
    timerSeconds: log.timerSeconds,
    distanceMeters: log.distanceMeters,
    caloriesKcal: log.timerSeconds === 0 ? 0 : log.lastTickCalories,
  });
}

export function closeRecordedWorkout(session) {
  if (!session || log.workoutSession !== session) return;
  log.workoutSession = null;
  log.workoutStep = null;
  appendWorkoutBoundary(null, Date.now(), { endsRun: true });
  persistRideLog();
}

export function recordWorkoutPause(session) {
  if (log.workoutSession !== session) return;
  log.workoutStep = session.paused ? null : session.index;
  appendWorkoutBoundary(session.steps[log.workoutStep]?.sourceIndex ?? null, Date.now(), { paused: session.paused });
  persistRideLog();
}

export function persistRideLog() {
  log.lastPersistAtMs = Date.now();
  if (!log.samples.length) {
    removeStored(RIDE_LOG_STORAGE_KEY);
    return;
  }

  const persisted = writeJson(RIDE_LOG_STORAGE_KEY, {
    startedAtMs: log.startedAtMs,
    timerSeconds: log.timerSeconds,
    distanceMeters: log.distanceMeters,
    samples: log.samples,
    workout: log.workout,
    workoutLaps: log.workoutLaps,
    lastTickAtMs: log.lastTickAtMs,
    lastTickCalories: log.lastTickCalories,
  });
  if (persisted) {
    log.persistBroken = false;
  } else if (!log.persistBroken) {
    // Quota exceeded on a very long ride — only possible on the localStorage
    // fallback path, IndexedDB quotas are far larger. The in-memory log keeps
    // recording and the FIT download still works; only crash recovery is lost.
    log.persistBroken = true;
    console.warn("Ride log no longer fits in browser storage; recording continues in memory only.");
  }
}

export function rideLogSummary() {
  const caloriesKcal = findLastCalories();
  return {
    sampleCount: log.samples.length,
    distanceMeters: log.distanceMeters,
    timerSeconds: log.timerSeconds,
    startedAtMs: log.startedAtMs,
    endTimeMs: log.lastTickAtMs,
    elapsedSeconds: log.lastTickAtMs !== null && log.startedAtMs
      ? Math.max(log.timerSeconds, (log.lastTickAtMs - log.startedAtMs) / 1000)
      : log.timerSeconds,
    heartRateSampleCount: log.samples.reduce((count, sample) => count + (sample[7] !== null ? 1 : 0), 0),
    caloriesKcal,
    persistBroken: log.persistBroken,
  };
}

function findLastCalories() {
  for (let i = log.samples.length - 1; i >= 0; i -= 1) {
    if (log.samples[i][8] !== null) return log.samples[i][8];
  }
  return null;
}

export function rideLogSamples() {
  return log.samples.map(([t, lat, lng, ele, distance, speedKph, powerWatts, heartRateBpm, caloriesKcal, routeProgressMeters, cadenceRpm]) => ({
    t,
    lat,
    lng,
    ele,
    distance,
    speedKph,
    powerWatts,
    heartRateBpm,
    caloriesKcal,
    routeProgressMeters: Number.isFinite(routeProgressMeters) ? routeProgressMeters : distance,
    cadenceRpm: Number.isFinite(cadenceRpm) ? cadenceRpm : null,
  }));
}

export function hasRideData() {
  return log.samples.length > 0;
}

export function rideLogWorkout(selectedWorkout) {
  return {
    workout: log.workoutLaps.length ? log.workout : selectedWorkout ?? log.workout,
    workoutLaps: log.workoutLaps,
  };
}

export function rideLogWorkoutFitRange() {
  if (!log.workout) return null;
  return workoutFitRange(log.workoutLaps, log.samples.length, ({ startMs, distanceMeters }) => {
    // Older logs did not store sample offsets. Disambiguate rounded timestamps
    // using the cumulative distance just before the boundary.
    const timestamp = Math.round(startMs / 1000);
    let low = 0;
    let high = log.samples.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const sample = log.samples[middle];
      if (sample[0] < timestamp || sample[4] <= distanceMeters) low = middle + 1;
      else high = middle;
    }
    return low;
  });
}

export function clearRideLog() {
  Object.assign(log, emptyLog());
  removeStored(RIDE_LOG_STORAGE_KEY);
}
