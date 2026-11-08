// Formats imported workout steps for preview using the rider's current FTP.
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

function decodeValue(value, unit, scale = 1) {
  if (!Number.isFinite(value)) return null;
  if (unit === "W") {
    return value <= 1000 ? { value, unit: "% FTP" } : { value: value - 1000, unit };
  }
  if (unit === "bpm") {
    return value <= 100 ? { value, unit: "% max HR" } : { value: value - 100, unit };
  }
  return { value: value / scale, unit };
}

function formatValue({ value, unit }) {
  if (unit === "s") {
    const milliseconds = Math.round(value * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = (milliseconds % 60000) / 1000;
    return [minutes && `${minutes} min`, seconds && `${seconds} s`].filter(Boolean).join(" ") || "0 min";
  }
  return unit ? `${value} ${unit}` : String(value);
}

function describeTarget(type, zone, low, high, ftpWatts) {
  if (type === undefined) return null;
  const [label, unit, scale] = TARGETS[type] ?? [`FIT target ${type}`];
  if (type === 2) return { text: label };
  if (zone) return { text: `${label} ${type === 11 ? zone : `Zone ${zone}`}` };

  const bounds = [low, high].map((value) => decodeValue(value, unit, scale)).filter(Boolean);
  const needsFtp = bounds.some((bound) => bound.unit === "% FTP");
  if (needsFtp && !ftpWatts) return { text: "Free ride", needsFtp };
  const values = bounds.map((bound) => {
    return bound.unit === "% FTP"
      ? formatValue({ value: Math.round(bound.value * ftpWatts / 100), unit: "W" })
      : formatValue(bound);
  });
  const range = [...new Set(values)].join("–");
  // Averaging windows and targets without units still need their labels.
  const showLabel = !unit || type >= 7;
  return { text: range && !showLabel ? range : [label, range].filter(Boolean).join(" ") };
}

function previewTimedStep(step, ftpWatts) {
  const detail = [formatValue({ value: step.durationSeconds, unit: "s" })];
  const needsFtp = Boolean(step.power && !ftpWatts);
  if (!step.power || needsFtp) {
    detail.push("Free ride");
  } else {
    const watts = step.power.map((fraction) => `${Math.round(fraction * ftpWatts)} W`);
    const ramp = step.power.length === 2 && step.power[0] !== step.power[1];
    detail.push(ramp ? watts.join(" → ") : watts[0]);
  }
  if (step.cadenceRpm) detail.push(`${step.cadenceRpm} rpm`);
  return { name: step.name, detail: detail.join(" · "), needsFtp };
}

export function previewWorkoutStep(step, ftpWatts) {
  if (step.durationSeconds !== undefined) return previewTimedStep(step, ftpWatts);
  const type = step[1];
  const repeat = REPEAT_CONDITIONS[type];
  const [label, unit, scale] = repeat ?? DURATION_TYPES[type] ?? [
    type === 5 ? "Open duration" : `FIT duration ${type}`,
  ];
  const value = decodeValue(repeat ? step[4] : step[2], unit, scale);
  const simpleDuration = type === 0 || type === 1 || type === 4 || type === 31;
  let duration = label;
  if (type !== 5 && value) {
    const amount = formatValue(value);
    duration = simpleDuration ? amount : `${label} ${amount}`;
  }
  const targets = [
    repeat ? null : describeTarget(step[3], step[4], step[5], step[6], ftpWatts),
    describeTarget(step[19], step[20], step[21], step[22], ftpWatts),
  ].filter(Boolean);

  const stepName = typeof step[0] === "string" ? step[0].trim() : "";
  return {
    name: stepName || (repeat ? `Repeat from step ${step[2] + 1}` : INTENSITIES[step[7]]) || "Step",
    detail: [duration, ...targets.map((target) => target.text)].join(" · "),
    notes: step[8],
    needsFtp: targets.some((target) => target.needsFtp),
  };
}
