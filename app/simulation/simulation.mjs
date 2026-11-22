// Runs the selected simulation in the ride's movement loop and owns its controls.

import { speedLimitConfig, turnSpeedProfile } from "../ride/speed-limits.mjs";
import { resetRoadMotion } from "../ride/road-speed.mjs";
import { els, state } from "../core/state.mjs";
import { WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { advanceDemoRide, createDemoRideModel, normalizeSimulationAthlete, simulationAthlete } from "../demo/demo.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { createSimulationRecording, persistSimulationRecording, recordSimulationTick, recordSimulationWorkoutBoundary, finishSimulationWorkout } from "./simulation-recorder.mjs";
import { ensureMovementLoop, setPedaling, updatePedalingFromTelemetry } from "../ride/movement.mjs";
import { updateRecordingUi } from "../ride/recording-ui.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { updateSpeedOutput } from "../settings/settings-ui.mjs";
import { advanceAlongRoad, gradeAt, interpolateRoutePoint, roadDistanceAt, routeTotalDistance } from "../route/route.mjs";
import { saveRide, saveSettings } from "../storage/persistence.mjs";
import { refreshRideTelemetry } from "../ride/telemetry-ui.mjs";
import { renderWorkout } from "../workout/workout-ui.mjs";
import { stopWorkoutErg } from "../workout/workout-erg.mjs";
import { expandTimedWorkoutSteps, normalizeWorkoutStep, workoutTargetWatts } from "../workout/workout-step.mjs";

const MODE_LABELS = {
  fixed: "Fixed speed",
  virtual: "Virtual rider",
  workout: "Workout mode",
};

export function registerSimulationHud() {
  registerHudComponent({ id: "simulation-banner", region: "center", weight: 20, element: els.simulationBanner });
}

export function updateSimulatorFromControl() {
  resetRoadMotion();
  state.simulatorEnabled = els.simulatorInput.checked;
  if (state.simulatorEnabled) {
    state.trainerProgressBeforeSimulation = state.progressMeters;
    if (state.workoutErg || state.workoutCountdown) stopWorkoutErg();
    setPedaling(false);
  } else {
    stopSimulation("", { refresh: false });
    if (state.trainerProgressBeforeSimulation !== null) {
      state.progressMeters = state.trainerProgressBeforeSimulation;
      state.trainerProgressBeforeSimulation = null;
    }
    updatePedalingFromTelemetry();
    saveRide();
  }
  state.simulationNotice = "";
  renderWorkout();
  if (state.route.length) {
    updateRideUi({ force: true });
  } else {
    refreshRideTelemetry();
    updateRecordingUi();
  }
}

export function selectSimulationMode(event) {
  if (!state.simulation) state.simulationMode = event.currentTarget.value;
  state.simulationNotice = "";
  renderWorkout();
}

export function selectSimulationAthlete(event) {
  if (state.simulation) return;
  state.simulationAthlete = normalizeSimulationAthlete(event.currentTarget.value);
  saveSettings();
  state.simulationNotice = "";
  renderWorkout();
}

export function effectiveWorkoutFtp() {
  if (state.simulatorEnabled && state.simulationMode === "workout") {
    return state.simulation?.workout?.ftp ?? simulationAthlete(state.simulationAthlete).ftp_watts;
  }
  return state.ftpWatts;
}

export function updateSimulationSpeed() {
  updateSpeedOutput();
  saveRide();
  if (state.simulation?.mode === "fixed") {
    advanceVirtualRider(state.simulation, 0, gradeAt(state.route, state.progressMeters));
  }
  if (!state.pedaling) updateRideUi({ force: true });
}

export function toggleSimulation() {
  if (!state.simulatorEnabled) return;
  if (state.simulation) {
    stopSimulation();
    return;
  }
  const mode = state.simulationMode;
  const steps = mode === "workout" ? timedWorkoutSteps() : null;
  if (simulationUnavailable(mode, steps)) return;
  resetRoadMotion();
  const config = { ...simulationAthlete(state.simulationAthlete), bike_weight_kg: state.bikeWeightKg, inertia_enabled: state.inertiaEnabled };
  const workout = steps ? { steps, index: 0, elapsed: 0, ftp: config.ftp_watts } : null;
  if (state.progressMeters >= routeTotalDistance(state.route)) state.progressMeters = 0;
  const model = createDemoRideModel(config);
  const recording = createSimulationRecording(Date.now(), workout ? state.workout : null);
  const simulation = { mode, model, config, telemetry: null, workout, recording, ergStep: false };
  state.simulation = simulation;
  advanceVirtualRider(simulation, 0, gradeAt(state.route, state.progressMeters));
  recordSimulationPosition(simulation, 0);
  if (workout) recordSimulationWorkoutBoundary(recording, workout.steps[0].sourceIndex);
  updateSimulationControls("");
  state.lastTick = performance.now();
  ensureMovementLoop();
  updateRideUi({ force: true });
  saveRide();
}

export function stopSimulation(message = "", { refresh = true } = {}) {
  const simulation = state.simulation;
  if (!simulation) return;
  recordSimulationPosition(simulation, 0, true);
  persistSimulationRecording();
  state.simulation = null;
  updateSimulationControls(message);
  if (refresh) {
    updateRideUi({ force: true, skipTrainerGrade: true });
    saveRide();
  }
}

export function handleSimulationWorkoutChange() {
  if (state.simulationMode !== "workout") {
    updateSimulationControls("");
    return;
  }

  const active = state.simulation?.workout;
  if (active || !timedWorkoutSteps()) {
    state.simulationMode = "virtual";
    if (active) {
      recordSimulationPosition(state.simulation, 0, true);
      finishSimulationWorkout(state.simulation.recording);
      state.simulation.mode = "virtual";
      state.simulation.workout = null;
    }
  }
  updateSimulationControls(active ? "Continuing with Virtual rider." : "");
  if (active) updateRideUi({ force: true });
}

export function updateSimulationControls(message = state.simulationNotice) {
  state.simulationNotice = message;
  const { simulation, simulationMode } = state;
  const steps = timedWorkoutSteps();
  const unavailable = simulation ? "" : simulationUnavailable(simulationMode, steps);
  els.simulationControls.hidden = !state.simulatorEnabled;
  els.simulationModeSelect.value = simulationMode;
  els.simulationModeSelect.disabled = Boolean(simulation);
  els.simulationAthleteSelect.value = state.simulationAthlete;
  els.simulationAthleteSelect.disabled = Boolean(simulation);
  els.simulationWorkoutOption.disabled = !steps;
  els.simulationSpeedControl.hidden = simulationMode !== "fixed";
  els.startBtn.disabled = !simulation && Boolean(unavailable);
  els.simulationWorkoutStartBtn.hidden = !state.simulatorEnabled || simulationMode !== "workout" || Boolean(simulation);
  els.simulationWorkoutStartBtn.disabled = els.startBtn.disabled;
  els.startBtn.classList.toggle("sim-running", Boolean(simulation));

  const workoutHint = state.workout && !steps ? "Workout mode requires timed steps." : "";
  const status = message || unavailable || (!simulation ? workoutHint : "");
  if (els.simulationStatus.textContent !== status) els.simulationStatus.textContent = status;
  els.simulationStatus.hidden = !status;
  els.simulationBanner.hidden = !simulation;
  if (simulation) els.simulationBanner.textContent = `Simulation · ${MODE_LABELS[simulation.mode]}`;
}

function simulationUnavailable(mode, steps) {
  if (state.route.length < 2 || routeTotalDistance(state.route) <= 0) return "Load a route to start.";
  if (mode === "workout" && !steps) return "Choose a workout with timed steps.";
  return "";
}

function timedWorkoutSteps() {
  const source = state.workout?.steps;
  if (!source?.length || source.length > WORKOUT_PROFILE_STEP_LIMIT) return null;
  const steps = expandTimedWorkoutSteps(source.map((step, sourceIndex) => ({ ...normalizeWorkoutStep(step), sourceIndex })));
  return steps?.length ? steps : null;
}

export function simulationSpeedKph() {
  const simulation = state.simulation;
  if (!simulation) return null;
  return simulation.telemetry?.speedKph ?? 0;
}

export function advanceSimulation(elapsedSeconds, finishMeters) {
  const simulation = state.simulation;

  let remaining = elapsedSeconds;
  const workout = simulation.workout;
  const finishRoadMeters = roadDistanceAt(state.route, finishMeters);
  while (remaining > 0 && state.progressMeters < finishMeters) {
    const step = workout?.steps[workout.index];
    const stepRemaining = step ? step.durationSeconds - workout.elapsed : Infinity;
    const grade = gradeAt(state.route, state.progressMeters);
    const distanceLeft = finishRoadMeters - roadDistanceAt(state.route, state.progressMeters);
    const requestedSeconds = Math.min(remaining, stepRemaining);
    advanceVirtualRider(simulation, requestedSeconds, grade, distanceLeft);
    // Keep the consumed slice directly; subtracting two session clocks can
    // leave a tiny unconsumable remainder and stall this loop.
    const seconds = simulation.model.elapsedSecondsAdvanced;
    const advancement = simulation.model.distanceMetersAdvanced >= distanceLeft
      ? { progress: finishMeters, metersAdvanced: distanceLeft }
      : advanceAlongRoad(state.route, state.progressMeters, simulation.model.distanceMetersAdvanced);
    state.progressMeters = advancement.progress;
    recordSimulationPosition(simulation, advancement.metersAdvanced);
    remaining -= seconds;
    if (!step) continue;
    if (requestedSeconds < stepRemaining || seconds < requestedSeconds) {
      workout.elapsed += seconds;
    } else {
      workout.elapsed = 0;
      workout.index += 1;
      if (workout.index === workout.steps.length) break;
      if (state.progressMeters < finishMeters) {
        recordSimulationWorkoutBoundary(simulation.recording, workout.steps[workout.index].sourceIndex);
      }
    }
  }

  return Boolean(workout && workout.index === workout.steps.length);
}

function recordSimulationPosition(simulation, metersAdvanced, final = false) {
  recordSimulationTick(simulation.recording, {
    point: interpolateRoutePoint(state.route, state.progressMeters),
    routeProgressMeters: state.progressMeters,
    metersAdvanced,
    telemetry: simulation.telemetry,
    elapsedSeconds: simulation.model.elapsedSeconds,
    caloriesKcal: simulation.model.caloriesKcal,
    final,
  });
}

function advanceVirtualRider(simulation, seconds, grade, maxDistanceMeters = Infinity) {
  simulation.config.bike_weight_kg = state.bikeWeightKg;
  simulation.config.inertia_enabled = state.inertiaEnabled;
  const workout = simulation.workout;
  const step = workout?.steps[workout.index];
  const target = step ? workoutTargetWatts(step, workout.ftp, workout.elapsed + seconds / 2) : null;
  simulation.ergStep = simulation.mode === "workout" && target > 0;
  simulation.config.max_speed_kph = simulation.ergStep ? Infinity : state.maxRideSpeedKph;
  simulation.telemetry = advanceDemoRide(simulation.model, {
    elapsedSeconds: seconds,
    gradePercent: grade,
    targetPowerWatts: target,
    fixedSpeedKph: simulation.mode === "fixed" ? Number(els.speedInput.value) : null,
    maxDistanceMeters,
    speedLimits: simulation.ergStep ? false : { config: speedLimitConfig(), profile: turnSpeedProfile(), roadMeters: roadDistanceAt(state.route, state.progressMeters) },
    config: simulation.config,
  });
}
