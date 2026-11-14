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
import { sliceWorkoutFit } from "./workout-fit-slice.mjs";
import { resetRide } from "./movement.mjs";

export function updateRecordingUi() {
  // The bucket only grows while the rider is actually moving — mirror that
  // with the pulsing RECORDING indicator on the FIT buffer card.
  els.recIndicator.hidden = !state.pedaling || state.demoModeActive;

  const summary = rideLogSummary();
  els.recDistanceStat.textContent = formatDistance(summary.distanceMeters, state.distanceUnits);
  els.recTimeStat.textContent = formatDuration(summary.timerSeconds, state.durationFormat);
  els.recPointsStat.textContent = String(summary.sampleCount);
  els.recHeartRateStat.textContent = summary.heartRateSampleCount > 0
    ? `${summary.heartRateSampleCount} samples`
    : "--";
  els.recCaloriesStat.textContent = formatEnergy(summary.caloriesKcal ?? NaN, state.energyUnits);
  const exportLocked = workoutExportLocked();
  els.downloadFitBtn.disabled = exportLocked || summary.sampleCount < 2;
  els.downloadWorkoutFitBtn.disabled = exportLocked || !rideLogWorkoutFitRange();
  els.resetBtn.disabled = summary.sampleCount === 0;
}

export function downloadFitFile() {
  downloadFit(false);
}

export function downloadWorkoutFitFile() {
  downloadFit(true);
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
  link.download = `gpx-rider-${workoutOnly ? "workout" : "virtual-ride"}-${stamp}.fit`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  // Keep both downloads available until the rider explicitly resets the buffer.
  if (range) return;
  window.setTimeout(() => {
    if (workoutExportLocked()) return;
    if (hasRideData()) confirmResetRide({ downloaded: true });
  }, 300);
}

function workoutExportLocked() {
  return Boolean(state.workoutErg || state.workoutCountdown);
}

export function confirmResetRide({ downloaded = false } = {}) {
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
