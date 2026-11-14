// Advances the ride from real pedaling or the active simulation.

import { closeOverviewModeMenu, syncOverviewControls } from "../camera/camera-ui.mjs";
import { syncFocusedClimbList } from "../route/climbs-ui.mjs";
import { advanceSimulation, simulationSpeedKph, stopSimulation, updateSimulationControls } from "../simulation/simulation.mjs";
import { persistSimulationRecording } from "../simulation/simulation-recorder.mjs";
import { cyclingSpeedForPower } from "./cycling-speed.mjs";
import { recordEstimatorTick } from "./eta.mjs";
import { ensureCameraFlightLoop } from "../camera/follow-camera.mjs";
import { clamp } from "../core/geo.mjs";
import {
  clearOverviewAnimation,
  enterFinishOrbit,
  enterOverviewMode,
  returnToRiderCamera,
} from "../camera/overview-camera.mjs";
import { startCameraTransitionToFollow } from "../camera/transition-camera.mjs";
import { saveRide, saveRideThrottled } from "../storage/persistence.mjs";
import { renderProfile } from "../route/profile-ui.mjs";
import { persistRideLog, recordRideTick } from "./recorder.mjs";
import { updateRecordingUi } from "./recording-ui.mjs";
import { updateRideUi } from "./ride-ui.mjs";
import {
  advanceAlongRoad,
  ascentAt,
  descentAt,
  gradeAt,
  interpolateRoutePoint,
  routeTotalDistance,
} from "../route/route.mjs";
import { rebuildRouteStyle } from "../map/route-render.mjs";
import { els, state, updateProgressLabel } from "../core/state.mjs";
import { realCaloriesKcal, realHeartRate, updateRideSpeedUi } from "./telemetry-ui.mjs";
import { sendTrainerGrade } from "../trainer/trainer.mjs";
import {
  CYCLING_GROSS_EFFICIENCY,
  ERG_ROAD_SPEED,
  WORKOUT_ERG_POWER_TIMEOUT_MS,
  MAX_TICK_SECONDS,
  PEDALING_START_KPH,
  PEDALING_STOP_KPH,
} from "../core/tuning.mjs";
import { activeCaloriesFromPower } from "../core/units.mjs";

import {
  autoStartWorkout, pauseWorkoutErg, recordingWorkoutSession, stopWorkoutErg, updateWorkoutErg,
} from "../workout/workout-erg.mjs";

export function isMoving() {
  return Boolean(state.simulation || state.pedaling);
}

export function updatePedalingFromSpeed() {
  const speed = state.trainerSpeedKph;
  if (!Number.isFinite(speed)) {
    setPedaling(false);
    return;
  }
  if (!state.pedaling && speed >= PEDALING_START_KPH) setPedaling(true);
  else if (state.pedaling && speed <= PEDALING_STOP_KPH) setPedaling(false);
}

export function setPedaling(pedaling) {
  if (pedaling === state.pedaling) return;
  const wasSimulating = Boolean(state.simulation);
  state.pedaling = pedaling;

  if (pedaling) {
    if (wasSimulating) {
      stopSimulation("Pedaling detected. Following the trainer.", { refresh: false });
    }
    state.lastTick = performance.now();
    autoStartWorkout();
    ensureMovementLoop();
  } else {
    state.ergRoadSpeedKph = null;
    pauseWorkoutErg();
    updateRideSpeedUi();
    if (!state.simulation) handleMovementStopped();
  }
  if (!pedaling || !wasSimulating) updateSimulationControls();
}

export function ensureMovementLoop() {
  if (state.route.length < 2) return;
  // Actual movement (not a mere seek) hands the camera over to the follow
  // view; the camera flight then flies it in from wherever it is — e.g. down
  // from the route overview when the rider starts pedaling.
  if (isMoving()) {
    state.overviewActive = false;
    state.finishOrbitActive = false;
    if (state.focusedClimbIndex !== null) {
      state.focusedClimbIndex = null;
      syncFocusedClimbList();
      renderProfile();
      rebuildRouteStyle();
    }
    closeOverviewModeMenu();
    syncOverviewControls();
    // Hand the camera over once, on the actual overview→follow (or manual→
    // follow) switch — via a physical transition arc when one fits (it
    // captures the current driver's velocity before tearing that driver
    // down), else by dropping the animated-overview driver so the follow
    // flight (via updateMapCamera) can take over as before.
    if (state.cameraMode !== "follow") {
      const flying = startCameraTransitionToFollow();
      state.cameraMode = "follow";
      if (!flying) clearOverviewAnimation();
    }
  }
  if (state.movementLoopActive) return;
  state.movementLoopActive = true;
  state.lastTick = performance.now();
  scheduleTick();
}

// requestAnimationFrame stops in hidden tabs, which would freeze the ride —
// and the recording — while the user is pedaling with another tab focused.
// Fall back to a coarse timeout whenever the page is hidden.
function scheduleTick() {
  cancelScheduledTick();
  if (document.hidden) {
    state.tickTimeout = window.setTimeout(() => tick(performance.now()), 500);
  } else {
    state.tickRaf = requestAnimationFrame(tick);
  }
}

function cancelScheduledTick() {
  if (state.tickRaf !== null) cancelAnimationFrame(state.tickRaf);
  if (state.tickTimeout !== null) window.clearTimeout(state.tickTimeout);
  state.tickRaf = null;
  state.tickTimeout = null;
}

export function handleVisibilityChange() {
  // A pending rAF from before the tab was hidden only fires once the tab is
  // visible again; reschedule so the loop keeps ticking either way.
  if (state.movementLoopActive) scheduleTick();
  // Going hidden is the last dependable moment to persist: a background tab
  // can be discarded without beforeunload, and an IndexedDB write started
  // only in beforeunload may not get to commit.
  if (document.hidden) {
    saveRide();
    persistRideLog();
    persistSimulationRecording();
  }
}

function handleMovementStopped() {
  saveRide();
  persistRideLog();
  updateRecordingUi();
}

export function resetRide() {
  if (state.workoutErg || state.workoutCountdown) stopWorkoutErg();
  stopSimulation("", { refresh: false });
  resetRoutePosition();
  void sendTrainerGrade(0);
}

export function resetRoutePosition({ skipTrainerGrade = false } = {}) {
  updateSimulationControls("");
  state.progressMeters = 0;
  state.lastTick = performance.now();
  // A reset while stationary honors the chosen camera surface: overview stays
  // overview, rider camera stays with the rider.
  if (!isMoving()) {
    if (state.overviewActive) enterOverviewMode();
    else returnToRiderCamera();
  }
  updateRideUi({ force: true, skipTrainerGrade });
  saveRide();
}

function tick(now) {
  if (!isMoving() || state.route.length < 2) {
    state.movementLoopActive = false;
    // The movement loop was driving the camera flight; let the flight loop
    // finish any move still in progress.
    ensureCameraFlightLoop();
    return;
  }

  const elapsedSeconds = clamp((now - state.lastTick) / 1000, 0, MAX_TICK_SECONDS);
  state.lastTick = now;
  const totalDistance = routeTotalDistance(state.route);
  let workoutComplete = false;
  if (state.simulation) workoutComplete = advanceSimulation(elapsedSeconds, totalDistance);
  else advanceRealRide(now, elapsedSeconds);

  if (state.progressMeters >= totalDistance) {
    const simulated = Boolean(state.simulation);
    if (!simulated && state.workoutErg) stopWorkoutErg("Route finished.");
    stopSimulation("Route finished.", { refresh: false });
    state.movementLoopActive = false;
    enterFinishOrbit();
    ensureCameraFlightLoop();
    updateRideUi({ force: true, skipTrainerGrade: simulated });
    handleMovementStopped();
    if (state.pedaling) void sendTrainerGrade(0);
    return;
  }

  if (workoutComplete) {
    stopSimulation("Workout simulation complete.");
    state.movementLoopActive = false;
    ensureCameraFlightLoop();
    return;
  }

  updateRideUi();
  saveRideThrottled();
  scheduleTick();
}

function advanceRealRide(now, elapsedSeconds) {
  const previousProgress = state.progressMeters;
  updateErgRoadSpeed(now, elapsedSeconds, gradeAt(state.route, previousProgress));
  const speedKph = currentRideSpeedKph() ?? 0;
  const { progress, metersAdvanced } = advanceAlongRoad(state.route, previousProgress, speedKph / 3.6 * elapsedSeconds);
  state.progressMeters = progress;
  recordEstimatorTick(state.rideEstimator, {
    elapsedSeconds,
    distanceMeters: metersAdvanced,
    ascentMeters: ascentAt(state.route, progress) - ascentAt(state.route, previousProgress),
    descentMeters: descentAt(state.route, progress) - descentAt(state.route, previousProgress),
  });
  if (Number.isFinite(state.trainerPowerWatts)) {
    state.powerCaloriesKcal += activeCaloriesFromPower(
      state.trainerPowerWatts, elapsedSeconds, CYCLING_GROSS_EFFICIENCY,
    );
  }
  recordRideTick({
    elapsedSeconds,
    metersAdvanced,
    point: interpolateRoutePoint(state.route, progress),
    speedKph,
    powerWatts: state.trainerPowerWatts,
    heartRateBpm: realHeartRate(),
    caloriesKcal: realCaloriesKcal(),
    routeProgressMeters: progress,
    cadenceRpm: state.trainerCadenceRpm,
    workout: state.workout,
    workoutSession: state.workoutErg,
    workoutPaused: Boolean(state.workoutErg && !recordingWorkoutSession(now)),
  });
  updateWorkoutErg(now, elapsedSeconds);
}

export function currentRideSpeedKph() {
  if (state.workoutErg && !state.workoutErg.paused && state.pedaling) {
    return state.ergRoadSpeedKph ?? 0;
  }
  return simulationSpeedKph() ?? state.trainerSpeedKph;
}

function updateErgRoadSpeed(now, elapsedSeconds, grade) {
  if (!state.workoutErg || state.workoutErg.paused || !state.pedaling) {
    state.ergRoadSpeedKph = null;
    return;
  }
  const sampleAt = state.trainerPowerSampleAt;
  const power = state.trainerPowerWatts;
  if (sampleAt === null || now - sampleAt > WORKOUT_ERG_POWER_TIMEOUT_MS || !Number.isFinite(power)) {
    state.ergRoadSpeedKph = null;
    return;
  }
  const target = cyclingSpeedForPower(power, grade, ERG_ROAD_SPEED);
  const previous = state.ergRoadSpeedKph ?? target;
  const weight = 1 - Math.exp(-elapsedSeconds / ERG_ROAD_SPEED.speed_smoothing_tau_seconds);
  state.ergRoadSpeedKph = previous + (target - previous) * weight;
}

// Jump the rider to a distance along the route (profile click, climb click).
export function seekToMeters(meters) {
  if (!state.route.length) return;
  const wasMoving = isMoving();
  stopSimulation("Simulation stopped before seeking.", { refresh: false });
  state.progressMeters = clamp(meters, 0, routeTotalDistance(state.route));
  state.ergRoadSpeedKph = null;
  state.lastTick = performance.now();
  // A teleport while parked in the rider camera (clicking the elevation
  // profile) flies the transition arc from the old camera pose to the new
  // rider position, instead of a plain chase snap. Skip it while moving (the
  // follow camera is already tracking), in an overview (the framing shouldn't
  // move), and in manual mode (a manual drag should stay put). It captures the
  // pre-teleport pose itself, so start it before updateRideUi nudges the
  // chase; updateMapCamera yields while the arc owns the camera.
  if (!wasMoving && state.cameraMode !== "overview" && state.cameraMode !== "manual") {
    startCameraTransitionToFollow();
  }
  updateRideUi({ force: true });
  saveRide();
  ensureMovementLoop();
}
