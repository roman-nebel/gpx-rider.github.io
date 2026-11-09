// Builds the workout chart's time axis and power intervals from imported steps.
import { POWER_ZONE_LIMITS, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { expandTimedWorkoutSteps } from "./workout-step.mjs";

export function buildWorkoutProfile(steps, ftp) {
  if (steps.length > WORKOUT_PROFILE_STEP_LIMIT) return null;
  const expanded = expandTimedWorkoutSteps(steps);
  const timed = expanded !== null;
  const entries = expanded ?? steps;
  let position = 0;
  const intervals = entries.map((step) => {
    const width = timed ? step.durationSeconds : 1;
    const start = position;
    position += width;
    return { start, end: position, power: stepPower(step, ftp) };
  });
  const units = [...new Set(intervals.flatMap(({ power }) => power?.unit ? [power.unit] : []))];
  return { intervals, extent: position, timed, units: units.length ? units : [null] };
}

function stepPower(step, ftp) {
  const target = step.targets.find((entry) => entry.power && entry.bounds.length);
  if (!target) return null;
  const relative = target.needsFtp;
  const relativeOnly = target.bounds.every(({ unit }) => unit === "% FTP");
  if (!ftp && relative && !relativeOnly) {
    // A mixed-unit range has no comparable endpoints until FTP is known.
    return { relative, unit: null };
  }
  const unit = !ftp && relativeOnly ? "% FTP" : "W";
  const bounds = target.bounds.map(({ unit, value }) => unit === "% FTP" && ftp ? value * ftp / 100 : value);
  const high = Math.max(...bounds);
  return {
    start: target.ramp ? bounds[0] : high,
    end: target.ramp ? bounds[1] : high,
    low: target.ramp ? undefined : Math.min(...bounds),
    unit, relative, zone: target.zone,
  };
}


export function powerZone(power, scale) {
  if (!scale) return null;
  const zone = POWER_ZONE_LIMITS.findIndex((limit) => power / scale <= limit);
  return zone === -1 ? POWER_ZONE_LIMITS.length : zone;
}
