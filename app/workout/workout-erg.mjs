// Runs the selected timed workout and hands power targets to the trainer's ERG controller.
import { els, state } from "../core/state.mjs";
import { WORKOUT_ERG_POWER_TIMEOUT_MS, WORKOUT_ERG_UPDATE_MS, WORKOUT_START_COUNTDOWN_SECONDS } from "../core/tuning.mjs";
import { currentHeartRate, updateRideSpeedUi } from "../ride/telemetry-ui.mjs";
import { closeRecordedWorkout, recordWorkoutPause } from "../ride/recorder.mjs";
import { ensureMovementLoop, resetRide } from "../ride/movement.mjs";
import { updateWorkoutMeterTargets } from "../ride/training-zones.mjs";
import { gradeAt, routeTotalDistance } from "../route/route.mjs";
import {
  queueTrainerTargetPower,
  releaseTrainerTargetPower,
  trainerSupportsTargetPower,
} from "../trainer/trainer.mjs";
import { updateWorkoutHud } from "./workout-hud.mjs";
import { createWorkoutSummary, finishWorkoutSummary, sampleWorkoutSummary } from "./workout-summary.mjs";
import { expandTimedWorkoutSteps, normalizeWorkoutStep, workoutTargetWatts } from "./workout-step.mjs";

const ERG_HINT = "Let the trainer adjust resistance to match each step.";

export function toggleWorkoutErg() {
  if (!els.workoutErgInput.checked) {
    stopWorkoutErg();
    return;
  }
  startWorkoutErg();
}

function startWorkoutErg() {
  if (state.workoutCountdown) return;
  if (!state.workout || state.route.length < 2) {
    rejectWorkoutStart("Load a route before starting a workout.");
    return;
  }
  if (!trainerSupportsTargetPower()) {
    rejectWorkoutStart("Connect a trainer that supports target power.");
    return;
  }
  const steps = expandTimedWorkoutSteps(state.workout.steps.map((step, sourceIndex) => ({
    ...normalizeWorkoutStep(step), sourceIndex,
  })));
  if (!steps) {
    rejectWorkoutStart("ERG requires timed steps and a supported number of repeats.");
    return;
  }
  if (!steps.some((step) => workoutTargetWatts(step, state.ftpWatts, 0) > 0 ||
      workoutTargetWatts(step, state.ftpWatts, step.durationSeconds) > 0)) {
    rejectWorkoutStart("This workout needs a power target in watts or a rider FTP.");
    return;
  }

  if (state.workoutErg) stopWorkoutErg();
  els.workoutHudStartError.hidden = true;
  state.workoutResult = null;
  els.workoutErgInput.checked = true;
  state.workoutCountdown = { deadline: performance.now() + WORKOUT_START_COUNTDOWN_SECONDS * 1000, steps };
  updateCountdown();
}

function updateCountdown() {
  const countdown = state.workoutCountdown;
  if (!countdown) return;
  const remaining = countdown.deadline - performance.now();
  if (remaining > 0) {
    countdown.seconds = Math.ceil(remaining / 1000);
    setErgStatus(`Starting in ${countdown.seconds}…`);
    updateWorkoutHud();
    countdown.timer = window.setTimeout(updateCountdown, remaining - (countdown.seconds - 1) * 1000);
    return;
  }
  state.workoutCountdown = null;
  if (!trainerSupportsTargetPower()) {
    rejectWorkoutStart("Trainer disconnected.");
    return;
  }
  if (state.progressMeters >= routeTotalDistance(state.route)) resetRide();
  state.ergRoadSpeedKph = null;
  state.workoutErg = {
    steps: countdown.steps, index: 0, elapsed: 0, paused: false, nextWriteAt: 0, startedAtMs: Date.now(),
    summary: createWorkoutSummary(),
  };
  els.workoutErgInput.checked = true;
  setErgStatus("Ready. Start pedaling to begin the workout.");
  updateWorkoutHud();
  updateWorkoutMeterTargets();
  if (state.pedaling && !state.movementLoopActive) ensureMovementLoop();
}

export function stopWorkoutErg(message = ERG_HINT) {
  els.workoutHudStartError.hidden = true;
  window.clearTimeout(state.workoutCountdown?.timer);
  state.workoutCountdown = null;
  closeRecordedWorkout(state.workoutErg);
  if (state.workoutErg) releaseTrainerTargetPower(currentGrade());
  state.workoutErg = null;
  state.ergRoadSpeedKph = null;
  updateRideSpeedUi();
  els.workoutErgInput.checked = false;
  setErgStatus(message);
  updateWorkoutHud();
  updateWorkoutMeterTargets();
}

function rejectWorkoutStart(message) {
  stopWorkoutErg(message);
  els.workoutHudStartError.textContent = message;
  els.workoutHudStartError.hidden = false;
}

export function toggleWorkoutPause() {
  const session = state.workoutErg;
  if (!session) return;
  session.paused = !session.paused;
  recordWorkoutPause(session);
  if (session.paused) {
    pauseWorkoutErg();
    state.ergRoadSpeedKph = null;
    updateRideSpeedUi();
  } else {
    setErgStatus("Workout resumed. Pedal to continue.");
  }
  updateWorkoutHud();
  updateWorkoutMeterTargets();
  if (!session.paused && state.pedaling && !state.movementLoopActive) ensureMovementLoop();
}

export function useWorkoutHudPlay() {
  if (state.workoutErg) toggleWorkoutPause();
  else startWorkoutErg();
}

export function endWorkout() {
  stopWorkoutErg(state.workoutCountdown ? "Workout start canceled." : "Workout ended.");
}

export function pauseWorkoutErg() {
  const session = state.workoutErg;
  if (!session) return;
  releaseTrainerTargetPower(currentGrade());
  session.nextWriteAt = 0;
  setErgStatus(session.paused ? "Workout paused." : "Paused. Pedal to resume.");
}

export function handleWorkoutErgRejection(message) {
  if (state.workoutErg) stopWorkoutErg(`Trainer could not set target power. ${message}`);
}

export function recordingWorkoutSession(now) {
  const session = state.workoutErg;
  const sampleAt = state.trainerPowerSampleAt;
  if (!session || session.paused || !state.pedaling || state.demoModeActive || sampleAt === null ||
      now - sampleAt > WORKOUT_ERG_POWER_TIMEOUT_MS || state.trainerPowerWatts <= 0 ||
      state.trainerCadenceRpm === 0) return null;
  return session;
}

export function updateWorkoutErg(now, elapsedSeconds) {
  if (!state.workoutErg || state.workoutErg.paused) return;
  const session = recordingWorkoutSession(now);
  if (!session) {
    pauseWorkoutErg();
    return;
  }

  const telemetry = {
    power: state.trainerPowerWatts,
    heartRate: currentHeartRate(),
    cadence: state.trainerCadenceRpm,
    ftp: state.ftpWatts,
  };
  let remaining = elapsedSeconds;
  let step = session.steps[session.index];
  while (remaining >= step.durationSeconds - session.elapsed) {
    const seconds = step.durationSeconds - session.elapsed;
    sampleWorkoutSummary(session.summary, step, session.elapsed, seconds, telemetry);
    remaining -= seconds;
    session.elapsed = 0;
    step = session.steps[++session.index];
    session.nextWriteAt = 0;
    if (!step) {
      state.workoutResult = { workout: state.workout, ...finishWorkoutSummary(session.summary, session.steps) };
      stopWorkoutErg("Workout complete.");
      return;
    }
  }
  sampleWorkoutSummary(session.summary, step, session.elapsed, remaining, telemetry);
  session.elapsed += remaining;

  if (now < session.nextWriteAt) return;
  session.nextWriteAt = now + WORKOUT_ERG_UPDATE_MS;
  const target = workoutTargetWatts(step, state.ftpWatts, session.elapsed);
  if (!(target > 0)) {
    releaseTrainerTargetPower(currentGrade());
    setErgStatus(`Step ${session.index + 1} · Free ride`);
    return;
  }
  const watts = queueTrainerTargetPower(target);
  if (watts === null) stopWorkoutErg("Trainer target power is unavailable.");
  else setErgStatus(`Step ${session.index + 1} · ${watts} W target`);
}

function currentGrade() {
  return state.route.length ? gradeAt(state.route, state.progressMeters) : 0;
}

function setErgStatus(message) {
  if (els.workoutErgStatus.textContent !== message) els.workoutErgStatus.textContent = message;
}
