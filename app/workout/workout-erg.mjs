// Runs the selected timed workout and hands power targets to the trainer's ERG controller.
import { els, state } from "../core/state.mjs";
import { WORKOUT_ERG_POWER_TIMEOUT_MS, WORKOUT_ERG_UPDATE_MS } from "../core/tuning.mjs";
import { currentHeartRate, updateRideSpeedUi } from "../ride/telemetry-ui.mjs";
import { closeRecordedWorkout } from "../ride/recorder.mjs";
import { gradeAt } from "../route/route.mjs";
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
  if (!state.workout || state.route.length < 2) {
    stopWorkoutErg("Load a route before enabling ERG.");
    return;
  }
  if (!trainerSupportsTargetPower()) {
    stopWorkoutErg("Connect a trainer that supports target power.");
    return;
  }
  const steps = expandTimedWorkoutSteps(state.workout.steps.map((step, sourceIndex) => ({
    ...normalizeWorkoutStep(step), sourceIndex,
  })));
  if (!steps) {
    stopWorkoutErg("ERG requires timed steps and a supported number of repeats.");
    return;
  }
  if (!steps.some((step) => workoutTargetWatts(step, state.ftpWatts, 0) > 0 ||
      workoutTargetWatts(step, state.ftpWatts, step.durationSeconds) > 0)) {
    stopWorkoutErg("This workout needs a power target in watts or a rider FTP.");
    return;
  }

  state.ergRoadSpeedKph = null;
  state.workoutResult = null;
  state.workoutErg = { steps, index: 0, elapsed: 0, nextWriteAt: 0, summary: createWorkoutSummary() };
  setErgStatus("Ready. Start pedaling to begin the workout.");
  updateWorkoutHud();
}

export function stopWorkoutErg(message = ERG_HINT) {
  closeRecordedWorkout(state.workoutErg);
  if (state.workoutErg) releaseTrainerTargetPower(currentGrade());
  state.workoutErg = null;
  state.ergRoadSpeedKph = null;
  updateRideSpeedUi();
  els.workoutErgInput.checked = false;
  setErgStatus(message);
  updateWorkoutHud();
}

export function pauseWorkoutErg() {
  const session = state.workoutErg;
  if (!session) return;
  releaseTrainerTargetPower(currentGrade());
  session.nextWriteAt = 0;
  setErgStatus("Paused. Pedal to resume.");
}

export function handleWorkoutErgRejection(message) {
  if (state.workoutErg) stopWorkoutErg(`Trainer could not set target power. ${message}`);
}

export function recordingWorkoutSession(now) {
  const session = state.workoutErg;
  const sampleAt = state.trainerPowerSampleAt;
  if (!session || !state.pedaling || state.demoModeActive || sampleAt === null ||
      now - sampleAt > WORKOUT_ERG_POWER_TIMEOUT_MS || state.trainerPowerWatts <= 0 ||
      state.trainerCadenceRpm === 0) return null;
  return session;
}

export function updateWorkoutErg(now, elapsedSeconds) {
  if (!state.workoutErg) return;
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
