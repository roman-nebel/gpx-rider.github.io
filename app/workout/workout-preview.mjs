// Formats normalized workout steps for the sidebar list.
function formatValue({ value, unit }) {
  if (unit === "s") {
    const milliseconds = Math.round(value * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = (milliseconds % 60000) / 1000;
    return [minutes && `${minutes} min`, seconds && `${seconds} s`].filter(Boolean).join(" ") || "0 min";
  }
  return unit ? `${value} ${unit}` : String(value);
}

function describeTarget(target, ftpWatts) {
  if (target.needsFtp && !ftpWatts) return "Free ride";
  if (!target.bounds.length || target.zone !== undefined) return target.label;
  const values = target.bounds.map((bound) => bound.unit === "% FTP"
    ? formatValue({ value: Math.round(bound.value * ftpWatts / 100), unit: "W" })
    : formatValue(bound));
  const range = target.ramp ? values.join(" → ") : [...new Set(values)].join("–");
  return target.showLabel ? `${target.label} ${range}` : range;
}

export function previewWorkoutStep(step, ftpWatts) {
  const { label, value } = step.duration;
  const duration = [label, value && formatValue(value)].filter(Boolean).join(" ");
  return {
    name: step.name,
    detail: [duration, ...step.targets.map((target) => describeTarget(target, ftpWatts))].join(" · "),
    notes: step.notes,
    needsFtp: step.targets.some((target) => target.needsFtp),
  };
}
