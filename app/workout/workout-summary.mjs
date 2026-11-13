// Accumulates time-weighted workout measurements and power-target adherence.
import { WORKOUT_HUD_TARGET_TOLERANCE } from "../core/tuning.mjs";
import { workoutMeterTarget } from "./workout-step.mjs";

export function createWorkoutSummary() {
  return {
    power: { total: 0, seconds: 0 },
    heartRate: { total: 0, seconds: 0 },
    cadence: { total: 0, seconds: 0 },
    onTargetSeconds: 0,
    targetSeconds: 0,
  };
}

export function sampleWorkoutSummary(summary, step, elapsed, seconds, { power, heartRate, cadence, ftp }) {
  if (!(seconds > 0)) return;
  addMeasurement(summary.power, power, seconds, 0);
  addMeasurement(summary.heartRate, heartRate, seconds, 1);
  addMeasurement(summary.cadence, cadence, seconds, 0);

  const target = workoutMeterTarget(step, "W", { ftp, elapsed: elapsed + seconds / 2 });
  if (!target || !Number.isFinite(power) || power < 0) return;
  summary.targetSeconds += seconds;
  const tolerance = WORKOUT_HUD_TARGET_TOLERANCE.power;
  if (power >= target.min - tolerance && power <= target.max + tolerance) {
    summary.onTargetSeconds += seconds;
  }
}

function addMeasurement(measurement, value, seconds, minimum) {
  if (!Number.isFinite(value) || value < minimum) return;
  measurement.total += value * seconds;
  measurement.seconds += seconds;
}

export function finishWorkoutSummary(summary, steps) {
  const average = ({ total, seconds }) => seconds > 0 ? Math.round(total / seconds) : null;
  const hasCadenceTarget = steps.some((step) => step.targets.some((target) =>
    target.unit === "rpm" && target.bounds.length));
  return {
    onTarget: summary.targetSeconds > 0 ? Math.round(summary.onTargetSeconds / summary.targetSeconds * 100) : null,
    power: average(summary.power),
    heartRate: average(summary.heartRate),
    cadence: hasCadenceTarget ? average(summary.cadence) : null,
  };
}
