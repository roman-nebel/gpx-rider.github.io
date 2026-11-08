// Builds the workout chart's time axis and power intervals from imported steps.
import { WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";

export function buildWorkoutProfile(steps, ftp) {
  if (steps.length > WORKOUT_PROFILE_STEP_LIMIT) return null;
  const expanded = expandTimedSteps(steps);
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

function expandTimedSteps(steps) {
  const expanded = [];
  const offsets = [];
  for (const step of steps) {
    offsets.push(expanded.length);
    if (step.repeatCount !== undefined) {
      const block = expanded.slice(offsets[step.repeatFrom]);
      const copies = step.repeatCount - 1;
      if (expanded.length + block.length * copies > WORKOUT_PROFILE_STEP_LIMIT) return null;
      for (let copy = 0; copy < copies; copy += 1) expanded.push(...block);
    } else {
      if (!(step.durationSeconds > 0)) return null;
      expanded.push(step);
    }
  }
  return expanded;
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
