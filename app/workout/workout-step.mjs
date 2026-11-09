// Adapts persisted FIT and MyWhoosh steps to the same preview model.
import { POWER_ZONE_LIMITS, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";

const INTENSITIES = ["Active", "Rest", "Warmup", "Cooldown", "Recovery", "Interval", "Other"];
const TARGETS = [
  ["Speed", "m/s", 1000], ["Heart rate", "bpm"], ["Free ride"],
  ["Cadence", "rpm"], ["Power", "W"], ["Grade", "%"], ["Resistance"],
  ["3 s power", "W"], ["10 s power", "W"], ["30 s power", "W"], ["Lap power", "W"],
  ["Swim stroke"], ["Lap speed", "m/s", 1000], ["Lap heart rate", "bpm"],
];

const DURATION_TYPES = {
  0: ["Time", "s", 1000],
  1: ["Distance", "m", 100],
  2: ["Heart rate below", "bpm"],
  3: ["Heart rate above", "bpm"],
  4: ["Energy", "kcal"],
  14: ["Power below", "W"],
  15: ["Power above", "W"],
  16: ["Training Stress Score", "TSS", 10],
  19: ["3 s power below", "W"],
  20: ["10 s power below", "W"],
  21: ["30 s power below", "W"],
  22: ["3 s power above", "W"],
  23: ["10 s power above", "W"],
  24: ["30 s power above", "W"],
  25: ["Lap power below", "W"],
  26: ["Lap power above", "W"],
  28: ["Repetition time", "s", 1000],
  29: ["Repetitions"],
  31: ["Time", "s", 1000],
};

const REPEAT_CONDITIONS = {
  6: ["Repeat count"],
  7: DURATION_TYPES[0],
  8: DURATION_TYPES[1],
  9: DURATION_TYPES[4],
  10: DURATION_TYPES[2],
  11: DURATION_TYPES[3],
  12: DURATION_TYPES[14],
  13: DURATION_TYPES[15],
  17: ["Last lap power below", "W"],
  18: ["Last lap maximum power below", "W"],
  27: DURATION_TYPES[16],
};

function decodeFitPower(value) {
  return value <= 1000 ? { value, unit: "% FTP" } : { value: value - 1000, unit: "W" };
}

function decodeValue(value, unit, scale = 1) {
  if (!Number.isFinite(value)) return null;
  if (unit === "W") {
    return decodeFitPower(value);
  }
  if (unit === "bpm") {
    return value <= 100 ? { value, unit: "% max HR" } : { value: value - 100, unit };
  }
  return { value: value / scale, unit };
}

export function normalizeWorkoutStep(step) {
  if (step.durationSeconds !== undefined) {
    const targets = step.power ? [{
      label: "Power", power: true, needsFtp: true, ramp: step.power.length === 2 && step.power[0] !== step.power[1],
      bounds: step.power.map((fraction) => ({ value: fraction * 100, unit: "% FTP" })),
    }] : [{ label: "Free ride", bounds: [] }];
    if (step.cadenceRpm) targets.push({ label: "Cadence", unit: "rpm", bounds: [{ value: step.cadenceRpm, unit: "rpm" }] });
    return {
      name: step.name, durationSeconds: step.durationSeconds,
      duration: { value: { value: step.durationSeconds, unit: "s" } }, targets,
    };
  }

  const type = step[1];
  const repeat = REPEAT_CONDITIONS[type];
  const [label, unit, scale] = repeat ?? DURATION_TYPES[type] ?? [
    type === 5 ? "Open duration" : `FIT duration ${type}`,
  ];
  const value = type === 5 ? null : decodeValue(repeat ? step[4] : step[2], unit, scale);
  const simpleDuration = [0, 1, 4, 31].includes(type);
  const timed = [0, 28, 31].includes(type);
  const stepName = typeof step[0] === "string" ? step[0].trim() : "";

  return {
    name: stepName || (repeat ? `Repeat from step ${step[2] + 1}` : INTENSITIES[step[7]]) || "Step",
    notes: step[8],
    duration: { label: simpleDuration && value ? null : label, value },
    durationSeconds: timed ? value?.value : undefined,
    repeatFrom: type === 6 ? step[2] : undefined,
    repeatCount: type === 6 ? step[4] : undefined,
    targets: [
      repeat ? null : fitTarget(step[3], step[4], step[5], step[6]),
      fitTarget(step[19], step[20], step[21], step[22]),
    ].filter(Boolean),
  };
}

function fitTarget(type, zone, low, high) {
  if (type === undefined) return null;
  const [label, unit, scale] = TARGETS[type] ?? [`FIT target ${type}`];
  if (type === 2) return { label, bounds: [] };

  const power = unit === "W";
  if (zone) {
    const index = zone - 1;
    const knownPowerZone = power && index >= 0 && index <= POWER_ZONE_LIMITS.length;
    const floor = POWER_ZONE_LIMITS[index - 1] ?? 0;
    const ceiling = POWER_ZONE_LIMITS[index];
    const midpoint = ceiling === undefined ? floor : (floor + ceiling) / 2;
    return {
      label: `${label} ${type === 11 ? zone : `Zone ${zone}`}`,
      power, unit, zoneNumber: zone, needsFtp: knownPowerZone, zone: knownPowerZone ? index : undefined,
      bounds: knownPowerZone ? [{ value: midpoint * 100, unit: "% FTP" }] : [],
    };
  }

  const bounds = [low, high].map((value) => decodeValue(value, unit, scale)).filter(Boolean);
  return { label, bounds, power, unit, needsFtp: bounds.some(({ unit }) => unit === "% FTP"), showLabel: !unit || type >= 7 };
}

export function expandTimedWorkoutSteps(steps) {
  if (steps.length > WORKOUT_PROFILE_STEP_LIMIT) return null;
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

// ERG needs a single target. Use the midpoint of a FIT power range.
export function workoutTargetWatts(step, ftp, elapsed) {
  const target = step.targets.find((entry) => entry.power && entry.bounds.length);
  if (!target || (target.needsFtp && !ftp)) return null;
  const values = target.bounds.map(({ value, unit }) => unit === "% FTP" ? value * ftp / 100 : value);
  if (target.ramp) {
    const progress = Math.min(1, Math.max(0, elapsed / step.durationSeconds));
    return values[0] + (values[1] - values[0]) * progress;
  }
  return (Math.min(...values) + Math.max(...values)) / 2;
}

// Resolves the target band for one HUD meter without changing the workout data.
export function workoutMeterTarget(step, unit, { ftp, maxHeartRate, heartRateZones, elapsed }) {
  const target = step?.targets.find((entry) =>
    (entry.unit === unit || (unit === "W" && entry.power)) &&
    (entry.bounds.length || (unit === "bpm" && entry.zoneNumber)));
  if (!target || (target.needsFtp && !ftp)) return null;
  if (unit === "bpm" && target.zoneNumber) {
    const zone = heartRateZones?.[target.zoneNumber - 1];
    if (!zone) return null;
    return { min: zone.min, max: zone.max ?? maxHeartRate };
  }
  if (!target.bounds.length) return null;
  if (target.ramp) {
    const value = workoutTargetWatts(step, ftp, elapsed);
    return { min: value, max: value };
  }
  const values = target.bounds.map((bound) => {
    if (bound.unit === "% FTP") return bound.value * ftp / 100;
    if (bound.unit === "% max HR") return bound.value * maxHeartRate / 100;
    return bound.value;
  });
  if (!values.every(Number.isFinite)) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
