// Formats normalized workout steps for display.
import { formatDuration } from "../core/units.mjs";

const COMPACT_TARGET_UNITS = ["W", "rpm", "bpm"];
const NUMERIC_TARGET_UNITS = [...COMPACT_TARGET_UNITS, "% max HR"];

function formatValue({ value, unit }) {
  if (unit === "s") {
    const milliseconds = Math.round(value * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = (milliseconds % 60000) / 1000;
    return [minutes && `${minutes} min`, seconds && `${seconds} s`].filter(Boolean).join(" ") || "0 min";
  }
  return unit ? `${value} ${unit}` : String(value);
}

function describeTarget(target, ftpWatts, { compact = false, maxHeartRate } = {}) {
  if (target.needsFtp && !ftpWatts) return "Free ride";
  if (!target.bounds.length || target.zone !== undefined) return target.label;
  const bounds = target.bounds.map((bound) => {
    if (bound.unit === "% FTP") return { value: bound.value * ftpWatts / 100, unit: "W" };
    if (bound.unit === "% max HR" && maxHeartRate > 0) {
      return { value: bound.value * maxHeartRate / 100, unit: "bpm" };
    }
    return bound;
  });
  const values = bounds.map(({ value, unit }) => {
    const rounded = NUMERIC_TARGET_UNITS.includes(unit) ? Math.round(value) : value;
    return compact && COMPACT_TARGET_UNITS.includes(unit)
      ? String(rounded) : formatValue({ value: rounded, unit });
  });
  const range = target.ramp ? values.join("→") : [...new Set(values)].join("–");
  return target.showLabel ? `${target.label} ${range}` : range;
}

function describeDuration(step) {
  const { label, value } = step.duration;
  return [label, value && formatValue(value)].filter(Boolean).join(" ");
}

export function previewNextWorkoutStep(step, ftpWatts) {
  const power = step.targets.find((target) =>
    target.power && target.bounds.length && (!target.needsFtp || ftpWatts));
  const hasTarget = (unit) => step.targets.some((target) =>
    target.unit === unit && (target.bounds.length || target.zoneNumber));
  return {
    duration: Number.isFinite(step.durationSeconds)
      ? formatDuration(step.durationSeconds, "padded-clock") : describeDuration(step),
    power: power ? describeTarget(power, ftpWatts, { compact: true }) : "",
    cadence: hasTarget("rpm"),
    heartRate: hasTarget("bpm"),
    speed: hasTarget("m/s"),
  };
}

export function previewWorkoutStep(step, ftpWatts, maxHeartRate) {
  return {
    name: step.name,
    detail: [describeDuration(step), ...step.targets.map((target) => describeTarget(target, ftpWatts, { maxHeartRate }))]
      .filter(Boolean).join(" · "),
    notes: step.notes,
    needsFtp: step.targets.some((target) => target.needsFtp),
  };
}
