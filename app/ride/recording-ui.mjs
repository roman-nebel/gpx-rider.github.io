// Ride recording & FIT export: the FIT buffer card (recording indicator +
// summary stats), the FIT file download, and resetting a ride.
// The recording itself lives in recorder.mjs; the FIT encoding in fit.mjs.

import { encodeFitActivity } from "./fit.mjs";
import {
  clearRideLog,
  hasRideData,
  persistRideLog,
  rideLogSamples,
  rideLogSummary,
  rideLogWorkout,
  rideLogWorkoutFitRange,
} from "./recorder.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { formatDistance, formatDuration, formatEnergy } from "../core/units.mjs";
import { clearSimulationRecording, hasSimulationWorkout, latestSimulationRecording, simulationWorkoutFit } from "../simulation/simulation-recorder.mjs";
import { sliceWorkoutFit } from "./workout-fit-slice.mjs";
import { resetRide, resetRoutePosition } from "./movement.mjs";

export function updateRecordingUi() {
  const simulated = state.simulatorEnabled;
  const recording = simulated ? latestSimulationRecording() : null;
  const summary = simulated ? simulationSummary(recording) : rideLogSummary();
  els.recIndicator.hidden = simulated ? !state.simulation : !state.pedaling;

  els.recDistanceStat.textContent = formatDistance(summary.distanceMeters, state.distanceUnits);
  els.recTimeStat.textContent = formatDuration(summary.timerSeconds, state.durationFormat);
  els.recPointsStat.textContent = String(summary.sampleCount);
  els.recHeartRateStat.textContent = summary.heartRateSampleCount > 0
    ? `${summary.heartRateSampleCount} samples`
    : "--";
  els.recCaloriesStat.textContent = formatEnergy(summary.caloriesKcal ?? NaN, state.energyUnits);
  const exportLocked = simulated ? Boolean(state.simulation) : workoutExportLocked();
  els.downloadFitBtn.textContent = simulated ? "Export simulation data" : "Export full ride";
  els.resetBtn.textContent = simulated ? "Reset simulation" : "Reset ride";
  els.downloadFitBtn.disabled = exportLocked || summary.sampleCount < 2;
  const hasWorkoutData = simulated ? hasSimulationWorkout(recording) : Boolean(rideLogWorkoutFitRange());
  els.downloadWorkoutFitBtn.disabled = exportLocked || !hasWorkoutData;
  els.resetBtn.disabled = (simulated && exportLocked) || summary.sampleCount === 0;
}

function simulationSummary(recording) {
  return {
    distanceMeters: recording?.summary.totalDistanceMeters ?? 0,
    timerSeconds: recording?.summary.totalTimerSeconds ?? 0,
    sampleCount: recording?.samples.length ?? 0,
    heartRateSampleCount: recording?.samples.length ?? 0,
    caloriesKcal: recording?.summary.totalCalories ?? null,
  };
}

export function downloadFitFile() {
  if (state.simulatorEnabled) downloadSimulationFit(false);
  else downloadFit(false);
}

export function downloadWorkoutFitFile() {
  if (state.simulatorEnabled) downloadSimulationFit(true);
  else downloadFit(true);
}

function downloadSimulationFit(workoutOnly) {
  if (state.simulation) return;
  const recording = latestSimulationRecording();
  const output = workoutOnly ? simulationWorkoutFit(recording) : recording;
  if (!output || output.samples.length < 2) return;
  const kind = workoutOnly ? "simulation-workout" : "simulation";
  try {
    saveFitDownload(encodeFitActivity(output), output.summary.startTimeMs, kind);
  } catch (error) {
    console.error("Could not encode the simulation FIT file.", error);
    updateProgressLabel("Could not build the FIT file from the simulation.");
  }
}

export function resetSelectedRecording() {
  if (state.simulatorEnabled) void confirmResetSimulation();
  else confirmResetRide();
}

async function confirmResetSimulation() {
  if (state.simulation || !latestSimulationRecording()) return;
  const prompt = state.route.length
    ? "Return to the start of the route and delete the simulation recording?"
    : "Delete the simulation recording?";
  if (!window.confirm(prompt)) return;
  const route = state.route;
  const clearing = clearSimulationRecording();
  updateRecordingUi();
  try {
    await clearing;
    if (route.length && route === state.route && state.simulatorEnabled && !state.simulation) {
      resetRoutePosition({ skipTrainerGrade: true });
    }
  } catch (error) {
    console.error("Could not reset the simulation recording.", error);
    updateProgressLabel("Could not delete the simulation recording.");
    updateRecordingUi();
  }
}

function downloadFit(workoutOnly) {
  if (workoutExportLocked()) {
    updateProgressLabel("End the workout before downloading FIT files.");
    return;
  }
  const range = rideLogWorkoutFitRange();
  if (workoutOnly && !range) {
    updateProgressLabel("Not enough recorded workout data to download a FIT file.");
    return;
  }
  const samples = rideLogSamples();
  if (samples.length < 2) {
    updateProgressLabel("Not enough recorded ride data yet — ride a little first.");
    return;
  }

  persistRideLog();
  const summary = rideLogSummary();

  let bytes;
  let startTimeMs;
  try {
    const activity = {
      samples,
      ...rideLogWorkout(),
      summary: {
        startTimeMs: summary.startedAtMs,
        endTimeMs: summary.endTimeMs,
        totalElapsedSeconds: summary.elapsedSeconds,
        totalTimerSeconds: summary.timerSeconds,
        totalDistanceMeters: summary.distanceMeters,
        totalCalories: summary.caloriesKcal,
      },
    };
    const output = workoutOnly ? sliceWorkoutFit(activity, range) : activity;
    startTimeMs = output.summary.startTimeMs;
    bytes = encodeFitActivity(output);
  } catch (error) {
    console.error("Could not encode the FIT file.", error);
    updateProgressLabel("Could not build the FIT file from the recorded data.");
    return;
  }

  saveFitDownload(bytes, startTimeMs, workoutOnly ? "workout" : "virtual-ride");

  // Keep both downloads available until the rider explicitly resets the buffer.
  if (range) return;
  window.setTimeout(() => {
    if (state.simulatorEnabled || workoutExportLocked()) return;
    if (hasRideData()) confirmResetRide({ downloaded: true });
  }, 300);
}

function saveFitDownload(bytes, startTimeMs, kind) {
  const started = new Date(startTimeMs);
  const stamp = [
    started.getFullYear(),
    String(started.getMonth() + 1).padStart(2, "0"),
    String(started.getDate()).padStart(2, "0"),
  ].join("") + "-" + [
    String(started.getHours()).padStart(2, "0"),
    String(started.getMinutes()).padStart(2, "0"),
  ].join("");

  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gpx-rider-${kind}-${stamp}.fit`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function workoutExportLocked() {
  return Boolean(state.workoutErg || state.workoutCountdown);
}

function confirmResetRide({ downloaded = false } = {}) {
  if (!hasRideData()) return;
  const summary = rideLogSummary();
  const description = `${formatDistance(summary.distanceMeters, state.distanceUnits)} / ${formatDuration(summary.timerSeconds, state.durationFormat)}`;
  const action = state.route.length ? "Return to the start and delete" : "Delete";
  const message = `${action} the ride recording (${description})`;
  const prompt = downloaded ? `FIT file downloaded. ${message}?` : `${message} without downloading?`;
  if (!window.confirm(prompt)) return;
  clearRideLog();
  state.powerCaloriesKcal = 0;
  if (state.route.length) resetRide();
  updateRecordingUi();
  if (!state.route.length) updateProgressLabel("Ride data cleared.");
}
