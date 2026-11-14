// Live telemetry: callbacks the trainer/heart-rate hardware modules feed
// (trainer.mjs / heartrate.mjs hold the BLE state; this module owns what the
// app does with the numbers), the HR source-of-truth resolution, calories and
// ride-timer accessors, and the telemetry readouts in the panel + HUD.

import { latestSimulationRecording } from "../simulation/simulation-recorder.mjs";
import { isHeartRateConnected } from "../trainer/heartrate.mjs";
import { currentRideSpeedKph, setPedaling, updatePedalingFromSpeed } from "./movement.mjs";
import { rideLogSummary } from "./recorder.mjs";
import { gradeAt } from "../route/route.mjs";
import { els, state } from "../core/state.mjs";
import { stopWorkoutErg } from "../workout/workout-erg.mjs";
import { isTrainerConnected, trainerSupportsTargetPower } from "../trainer/trainer.mjs";
import { updateTrainingMeters } from "./training-zones.mjs";
import { HEART_RATE_REFRESH_MS } from "../core/tuning.mjs";
import { formatEnergy, formatSpeed } from "../core/units.mjs";

export function handleTrainerTelemetry(telemetry) {
  // Live telemetry is the one dependable "actually connected" signal.
  els.trainerDot.classList.toggle("connected", Boolean(telemetry));

  if (!telemetry) {
    state.trainerSpeedKph = null;
    state.trainerPowerWatts = null;
    state.trainerPowerSampleAt = null;
    if (state.workoutErg || state.workoutCountdown) stopWorkoutErg("Trainer disconnected.");
    state.trainerCadenceRpm = null;
    state.trainerHeartRateBpm = null;
    setPedaling(false);
    updateTelemetryUi();
    updateTrainingMeters(state.route.length ? gradeAt(state.route, state.progressMeters) : NaN);
    return;
  }

  if (telemetry.speedKph !== null) state.trainerSpeedKph = telemetry.speedKph;
  if (telemetry.powerWatts !== null) {
    state.trainerPowerWatts = telemetry.powerWatts;
    if (telemetry.powerSampleFresh !== false) state.trainerPowerSampleAt = performance.now();
  }
  if (telemetry.cadenceRpm !== null) state.trainerCadenceRpm = telemetry.cadenceRpm;
  if (telemetry.totalCaloriesKcal !== null) state.trainerCaloriesKcal = telemetry.totalCaloriesKcal;
  state.trainerHeartRateBpm = telemetry.heartRateBpm;

  updatePedalingFromSpeed();
  updateTelemetryUi();
  updateTrainingMeters(state.route.length ? gradeAt(state.route, state.progressMeters) : NaN);
}

export function handleTrainerStatus(text, { onlyClearError = false } = {}) {
  const connected = isTrainerConnected();
  els.trainerSettingsBtn.hidden = !connected;
  els.trainerErg.hidden = !connected || !trainerSupportsTargetPower();
  if (!connected) {
    els.trainerSettings.hidden = true;
    els.trainerSettingsBtn.setAttribute("aria-expanded", "false");
  }
  if (onlyClearError && els.trainerStat.textContent !== "BLE error") return;
  els.trainerStat.textContent = text;
}

export function handleStrapHeartRate(bpm) {
  state.strapHeartRateBpm = Number.isFinite(bpm) ? bpm : null;
  refreshRideTelemetry();
  syncHeartRateRefreshLoop();
}

export function handleHeartRateStatus(text) {
  state.heartRateStatusText = text;
  refreshRideTelemetry();
  syncHeartRateRefreshLoop();
}

export function currentHeartRate() {
  return state.simulatorEnabled ? state.simulation?.telemetry?.heartRateBpm ?? null : realHeartRate();
}

export function realHeartRate() {
  // A connected strap is the HR source of truth. Only fall back to a
  // trainer-relayed HR field when no dedicated strap is connected.
  if (isHeartRateConnected()) return state.strapHeartRateBpm;
  return state.trainerHeartRateBpm ?? null;
}

export function refreshRideTelemetry() {
  updateTelemetryUi();
  updateTrainingMeters(state.route.length ? gradeAt(state.route, state.progressMeters) : NaN);
}

function syncHeartRateRefreshLoop() {
  if (isHeartRateConnected()) {
    startHeartRateRefreshLoop();
  } else {
    stopHeartRateRefreshLoop();
  }
}

function startHeartRateRefreshLoop() {
  if (state.heartRateRefreshTimer) return;
  const step = () => {
    if (!isHeartRateConnected()) {
      state.heartRateRefreshTimer = null;
      refreshRideTelemetry();
      return;
    }
    refreshRideTelemetry();
    state.heartRateRefreshTimer = window.setTimeout(step, HEART_RATE_REFRESH_MS);
  };
  step();
}

function stopHeartRateRefreshLoop() {
  window.clearTimeout(state.heartRateRefreshTimer);
  state.heartRateRefreshTimer = null;
}

export function currentCaloriesKcal() {
  if (!state.simulatorEnabled) return realCaloriesKcal();
  return state.simulation?.model.caloriesKcal ?? latestSimulationRecording()?.summary.totalCalories ?? null;
}

export function realCaloriesKcal() {
  if (state.powerCaloriesKcal > 0 || Number.isFinite(state.trainerPowerWatts)) {
    return state.powerCaloriesKcal;
  }
  return Number.isFinite(state.trainerCaloriesKcal) ? state.trainerCaloriesKcal : null;
}

export function currentRideTimerSeconds() {
  if (state.simulatorEnabled) {
    return state.simulation?.model.elapsedSeconds ?? latestSimulationRecording()?.summary.totalTimerSeconds ?? 0;
  }
  return rideLogSummary().timerSeconds;
}

export function currentRidePowerWatts() {
  return state.simulatorEnabled ? state.simulation?.telemetry?.powerWatts ?? null : state.trainerPowerWatts;
}

export function currentRideCadenceRpm() {
  return state.simulatorEnabled ? state.simulation?.telemetry?.cadenceRpm ?? null : state.trainerCadenceRpm;
}

export function updateTelemetryUi() {
  const power = currentRidePowerWatts();
  const powerText = Number.isFinite(power) ? `${power} W` : "--";
  const heartRate = currentHeartRate();
  const heartRateText = Number.isFinite(heartRate) ? `${heartRate} bpm` : "--";
  const caloriesText = formatEnergy(currentCaloriesKcal() ?? NaN, state.energyUnits);
  const trainerConnected = Boolean(isTrainerConnected() || state.trainerSpeedKph !== null || state.trainerPowerWatts !== null);
  const heartRateConnected = isHeartRateConnected();

  els.powerStat.textContent = powerText;
  updateRideSpeedUi();
  els.heartRateStat.textContent = heartRateText;
  els.trainerDot.classList.toggle("connected", trainerConnected);
  els.hrConnectionStat.textContent = heartRateConnected && Number.isFinite(state.strapHeartRateBpm)
    ? `${state.strapHeartRateBpm} bpm`
    : (state.heartRateStatusText || (isHeartRateConnected() ? "Connected" : "Not connected"));
  els.hrDot.classList.toggle("connected", heartRateConnected);
  els.caloriesStat.textContent = caloriesText;
  els.hudPowerStat.textContent = powerText;
  els.hudHeartRateStat.textContent = heartRateText;
  els.hudCaloriesStat.textContent = caloriesText;
}


export function updateRideSpeedUi() {
  const speedText = formatSpeed(currentRideSpeedKph(), state.distanceUnits);
  if (els.speedStat.textContent !== speedText) els.speedStat.textContent = speedText;
  if (els.hudSpeedStat.textContent !== speedText) els.hudSpeedStat.textContent = speedText;
}
