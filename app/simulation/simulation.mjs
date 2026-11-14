// Runs the selected simulation in the ride's movement loop and owns its controls.

import { els, state } from "../core/state.mjs";
import { DEMO_RIDE, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { advanceDemoRide, createDemoRideModel, sampleDemoRide } from "../demo/demo.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { ensureMovementLoop } from "../ride/movement.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";
import { updateSpeedOutput } from "../settings/settings-ui.mjs";
import { advanceAlongRoad, gradeAt, interpolateRoutePoint, roadDistanceAt, routeTotalDistance } from "../route/route.mjs";
import { saveRide } from "../storage/persistence.mjs";
import { isHeartRateConnected } from "../trainer/heartrate.mjs";
import { isTrainerConnected } from "../trainer/trainer.mjs";
import { expandTimedWorkoutSteps, normalizeWorkoutStep, workoutTargetWatts } from "../workout/workout-step.mjs";

const MODE_LABELS = {
  fixed: "Fixed speed",
  virtual: "Virtual rider",
  workout: "Workout mode",
};

export function registerSimulationHud() {
  registerHudComponent({ id: "simulation-banner", region: "center", weight: 20, element: els.simulationBanner });
}

export function selectSimulationMode(event) {
  if (!state.simulation) state.simulationMode = event.currentTarget.value;
  updateSimulationControls("");
}

export function updateSimulationSpeed() {
  updateSpeedOutput();
  saveRide();
  if (state.simulation?.mode === "fixed" || !state.pedaling) updateRideUi({ force: true });
}

export function toggleSimulation() {
  if (state.simulation) {
    stopSimulation("Simulation stopped.");
    return;
  }
  const mode = state.simulationMode;
  const steps = mode === "workout" ? timedWorkoutSteps() : null;
  if (simulationUnavailable(mode, steps)) return;
  const workout = steps ? { steps, index: 0, elapsed: 0, ftp: state.ftpWatts || DEMO_RIDE.ftp_watts } : null;
  if (state.progressMeters >= routeTotalDistance(state.route)) state.progressMeters = 0;
  const model = mode === "fixed" ? null : createDemoRideModel();
  const config = workout ? { ...DEMO_RIDE, ftp_watts: workout.ftp } : DEMO_RIDE;
  state.simulation = { mode, model, config, telemetry: null, workout };
  if (model) {
    const grade = gradeAt(state.route, state.progressMeters);
    advanceVirtualRider(state.simulation, 0, grade);
  }
  updateSimulationControls("");
  state.lastTick = performance.now();
  ensureMovementLoop();
  updateRideUi({ force: true });
  saveRide();
}

export function stopSimulation(message = "", { refresh = true } = {}) {
  if (!state.simulation) return;
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
      state.simulation.mode = "virtual";
      state.simulation.workout = null;
      state.simulation.config = DEMO_RIDE;
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
  els.simulationModeSelect.value = simulationMode;
  els.simulationModeSelect.disabled = Boolean(simulation);
  els.simulationWorkoutOption.disabled = !steps;
  els.simulationSpeedControl.hidden = simulationMode !== "fixed";
  els.startBtn.disabled = !simulation && Boolean(unavailable);
  els.startBtnLabel.textContent = simulation ? "Stop" : "Start";
  els.startBtn.classList.toggle("sim-running", Boolean(simulation));

  const workoutHint = state.workout && !steps ? "Workout mode requires timed steps." : "";
  const ftpHint = simulationMode === "workout" && !state.ftpWatts
    ? `Using the virtual rider's FTP of ${DEMO_RIDE.ftp_watts} W.` : "";
  const status = message || unavailable || (!simulation ? workoutHint || ftpHint : "");
  if (els.simulationStatus.textContent !== status) els.simulationStatus.textContent = status;
  els.simulationStatus.hidden = !status;
  els.simulationBanner.hidden = !simulation;
  if (simulation) els.simulationBanner.textContent = `Simulation · ${MODE_LABELS[simulation.mode]}`;
}

function simulationUnavailable(mode, steps) {
  if (state.route.length < 2 || routeTotalDistance(state.route) <= 0) return "Load a route to start.";
  if (state.pedaling) return "Stop pedaling to start simulation.";
  if (mode !== "fixed" && (isTrainerConnected() || isHeartRateConnected())) {
    return "Disconnect the trainer and heart rate monitor to start.";
  }
  if (mode === "workout" && !steps) return "Choose a workout with timed steps.";
  return "";
}

function timedWorkoutSteps() {
  const source = state.workout?.steps;
  if (!source?.length || source.length > WORKOUT_PROFILE_STEP_LIMIT) return null;
  const steps = expandTimedWorkoutSteps(source.map(normalizeWorkoutStep));
  return steps?.length ? steps : null;
}

export function simulationSpeedKph() {
  const simulation = state.simulation;
  if (!simulation) return null;
  if (simulation.mode === "fixed") return Number(els.speedInput.value);
  return simulation.telemetry?.speedKph ?? 0;
}

export function advanceSimulation(elapsedSeconds, now, finishMeters) {
  const simulation = state.simulation;
  if (simulation.mode === "fixed") {
    const { progress } = advanceAlongRoad(state.route, state.progressMeters, simulationSpeedKph() / 3.6 * elapsedSeconds);
    state.progressMeters = progress;
    return false;
  }

  let remaining = elapsedSeconds;
  let metersAdvanced = 0;
  const workout = simulation.workout;
  const finishRoadMeters = roadDistanceAt(state.route, finishMeters);
  while (remaining > 0 && state.progressMeters < finishMeters) {
    const step = workout?.steps[workout.index];
    const stepRemaining = step ? step.durationSeconds - workout.elapsed : Infinity;
    const grade = gradeAt(state.route, state.progressMeters);
    const distanceLeft = finishRoadMeters - roadDistanceAt(state.route, state.progressMeters);
    // Integrate distance at the speed at the start of this slice, then
    // advance the virtual rider to get the speed for the next slice.
    const speedMps = simulation.model.speedKph / 3.6;
    const secondsToFinish = distanceLeft / speedMps;
    const seconds = Math.min(remaining, stepRemaining, secondsToFinish);
    advanceVirtualRider(simulation, seconds, grade);
    const advancement = seconds === secondsToFinish
      ? { progress: finishMeters, metersAdvanced: distanceLeft }
      : advanceAlongRoad(state.route, state.progressMeters, speedMps * seconds);
    state.progressMeters = advancement.progress;
    metersAdvanced += advancement.metersAdvanced;
    remaining -= seconds;
    if (!step) continue;
    if (seconds < stepRemaining) {
      workout.elapsed += seconds;
    } else {
      workout.elapsed = 0;
      workout.index += 1;
      if (workout.index === workout.steps.length) break;
    }
  }

  sampleDemoRide(simulation.model, {
    point: interpolateRoutePoint(state.route, state.progressMeters),
    routeProgressMeters: state.progressMeters,
    metersAdvanced,
    telemetry: simulation.telemetry,
    nowSeconds: (performance.timeOrigin + now) / 1000,
  });
  return Boolean(workout && workout.index === workout.steps.length);
}

function advanceVirtualRider(simulation, seconds, grade) {
  const workout = simulation.workout;
  const step = workout?.steps[workout.index];
  const target = step ? workoutTargetWatts(step, workout.ftp, workout.elapsed + seconds / 2) : null;
  simulation.telemetry = advanceDemoRide(simulation.model, {
    elapsedSeconds: seconds,
    gradePercent: grade,
    targetPowerWatts: target,
    config: simulation.config,
  });
}
