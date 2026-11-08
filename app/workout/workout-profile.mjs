// Builds the workout chart's time axis and power intervals from imported steps.
import { POWER_ZONE_LIMITS, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { decodeFitPower } from "./workout-preview.mjs";

export function buildWorkoutProfile(steps, ftp) {
  const expanded = expandTimedSteps(steps);
  const timed = expanded !== null;
  const entries = expanded ?? steps;
  let position = 0;
  const intervals = entries.map((step) => {
    const width = timed ? durationSeconds(step) : 1;
    const start = position;
    position += width;
    return { start, end: position, power: stepPower(step, ftp) };
  });
  const units = [...new Set(intervals.flatMap(({ power }) => power?.unit ? [power.unit] : []))];
  return { intervals, extent: position, timed, units: units.length ? units : [null] };
}

function durationSeconds(step) {
  if (step.durationSeconds !== undefined) return step.durationSeconds;
  return [0, 28, 31].includes(step[1]) ? step[2] / 1000 : null;
}

function expandTimedSteps(steps) {
  const expanded = [];
  const offsets = [];
  for (const step of steps) {
    offsets.push(expanded.length);
    if (step[1] === 6) {
      const block = expanded.slice(offsets[step[2]]);
      const copies = step[4] - 1;
      if (expanded.length + block.length * copies > WORKOUT_PROFILE_STEP_LIMIT) return null;
      for (let copy = 0; copy < copies; copy += 1) expanded.push(...block);
    } else {
      if (!(durationSeconds(step) > 0)) return null;
      expanded.push(step);
    }
  }
  return expanded;
}

function stepPower(step, ftp) {
  if (step.durationSeconds !== undefined) {
    if (!step.power) return null;
    const [start, end = start] = step.power;
    return relativePower(start, end, ftp);
  }
  const repeat = [6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 27].includes(step[1]);
  if (repeat) return null;
  for (const field of [3, 19]) {
    const type = step[field];
    if (![4, 7, 8, 9, 10].includes(type)) continue;
    const zone = step[field + 1];
    if (zone) {
      const low = POWER_ZONE_LIMITS[zone - 2] ?? 0;
      const high = POWER_ZONE_LIMITS[zone - 1];
      if (zone > POWER_ZONE_LIMITS.length + 1) return null;
      const target = high === undefined ? low : (low + high) / 2;
      return { ...relativePower(target, target, ftp), zone: zone - 1 };
    }
    const bounds = [step[field + 2], step[field + 3]].filter(Number.isFinite).map(decodeFitPower);
    if (!bounds.length) continue;
    if (bounds.every(({ unit }) => unit === "% FTP")) {
      const watts = bounds.map(({ value }) => value / 100);
      const target = relativePower(Math.max(...watts), Math.max(...watts), ftp);
      return { ...target, low: Math.min(...watts) * (ftp || 100) };
    }
    if (!ftp && bounds.some(({ unit }) => unit === "% FTP")) {
      // A mixed-unit range has no comparable endpoints until FTP is known.
      return { relative: true, unit: null };
    }
    const watts = bounds.map(({ unit, value }) => unit === "W" ? value : value * ftp / 100);
    const high = Math.max(...watts);
    return { start: high, end: high, low: Math.min(...watts), unit: "W",
      relative: bounds.some(({ unit }) => unit === "% FTP") };
  }
  return null;
}

function relativePower(start, end, ftp) {
  const scale = ftp || 100;
  return { start: start * scale, end: end * scale, unit: ftp ? "W" : "% FTP", relative: true };
}
