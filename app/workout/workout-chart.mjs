// Draws the workout's power profile in the sidebar.
import { POWER_ZONE_DEFINITIONS, POWER_ZONE_LIMITS, WORKOUT_PROFILE_FTP_CEILING } from "../core/tuning.mjs";
import { buildWorkoutProfile } from "./workout-profile.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 440;
const HEIGHT = 96;
const BASE = HEIGHT - 1;

export function renderWorkoutChart(container, steps, ftp) {
  const profile = buildWorkoutProfile(steps, ftp);
  if (!profile) {
    container.textContent = "This workout has too many steps to display a chart.";
    return;
  }
  const charts = profile.units.map((unit, index) => drawPlot(profile, unit, ftp, index));
  const axis = document.createElement("div");
  axis.className = "workout-chart-axis";
  axis.append(profile.timed ? "0 min" : "Step 1");
  const end = document.createElement("span");
  end.textContent = profile.timed
    ? `${Number((profile.extent / 60).toFixed(2))} min`
    : `Step ${profile.intervals.length}`;
  axis.append(end);

  container.replaceChildren(...charts, axis);
}

function drawPlot(profile, unit, ftp, index) {
  const svg = svgElement("svg", {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: "img",
    "aria-label": unit ? `Workout power profile in ${unit}` : "Workout steps without a power target",
  });
  const scale = unit === "% FTP" ? 100 : unit === "W" ? ftp : null;
  const defaultMaxPower = scale ? scale * WORKOUT_PROFILE_FTP_CEILING : 1;
  const maxPower = profile.intervals.reduce((max, { power }) =>
    power?.unit === unit && unit ? Math.max(max, power.start, power.end) : max, defaultMaxPower);
  const y = (power) => BASE - power / maxPower * (BASE - 6);
  const gradientId = `workout-zone-fill-${index}`;
  const maskId = `workout-hatch-mask-${index}`;
  const defs = svgElement("defs");
  if (scale) defs.append(zoneGradient(gradientId, y, maxPower, scale));
  defs.append(hatchMask(maskId));
  svg.append(defs);

  for (const position of [0.25, 0.5, 0.75, 1]) {
    const level = BASE * position;
    svg.append(svgElement("path", { d: `M0 ${level}H${WIDTH}`, class: "workout-chart-grid" }));
  }

  for (const { start, end, power } of profile.intervals) {
    const left = start / profile.extent * WIDTH;
    const width = (end - start) / profile.extent * WIDTH;
    const right = left + width - Math.min(1.4, width * 0.2);
    if (!power || !power.unit) {
      const d = intervalShape(left, right, BASE - 7, BASE - 7);
      svg.append(svgElement("path", { d, class: "workout-chart-open" }));
      if (power) svg.append(svgElement("path", { d, fill: "var(--muted)", mask: `url(#${maskId})` }));
      continue;
    }
    if (power.unit !== unit) continue;

    const startY = Math.min(BASE - 1, y(power.start));
    const endY = Math.min(BASE - 1, y(power.end));
    const ramp = power.start !== power.end;
    const zone = power.zone ?? powerZone((power.start + power.end) / 2, scale);
    const fill = ramp && scale ? `url(#${gradientId})` : POWER_ZONE_DEFINITIONS[zone]?.color ?? "var(--blue-soft)";
    const shape = { d: intervalShape(left, right, startY, endY), fill, class: "workout-chart-interval" };
    if (power.relative && !ftp) {
      svg.append(svgElement("path", { ...shape, "fill-opacity": 0.1 }));
      svg.append(svgElement("path", { ...shape, mask: `url(#${maskId})` }));
    } else {
      svg.append(svgElement("path", shape));
    }
    if (power.low !== undefined && power.low !== power.start) {
      const lowY = y(power.low);
      svg.append(svgElement("path", { d: `M${left} ${lowY}H${right}`, class: "workout-chart-range" }));
    }
  }

  if (scale) {
    const level = y(scale);
    svg.append(svgElement("path", { d: `M0 ${level}H${WIDTH}`, class: "workout-chart-ftp" }));
    const reference = svgElement("text", {
      x: WIDTH - 3, y: level - 3, "text-anchor": "end", class: "workout-chart-ftp-label",
    });
    reference.textContent = "FTP";
    const value = svgElement("text", {
      x: 3, y: level - 3, class: "workout-chart-ftp-label",
    });
    value.textContent = unit === "% FTP" ? "100%" : `${scale} W`;
    svg.append(value, reference);
  }

  const plot = document.createElement("div");
  plot.className = "workout-chart-plot";
  if (unit) {
    const label = document.createElement("span");
    label.className = "workout-chart-unit";
    const ceiling = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(maxPower);
    label.textContent = unit === "% FTP" ? `${ceiling}%` : `${ceiling} W`;
    plot.append(label);
  }
  plot.append(svg);
  return plot;
}

function intervalShape(left, right, startY, endY) {
  const width = right - left;
  const radius = Math.min(2.5, width / 2, BASE - startY, BASE - endY);
  const slope = (endY - startY) / width;
  const topInset = radius / Math.hypot(1, slope);
  return [
    `M${left} ${BASE}V${startY + radius}`,
    `Q${left} ${startY} ${left + topInset} ${startY + topInset * slope}`,
    `L${right - topInset} ${endY - topInset * slope}`,
    `Q${right} ${endY} ${right} ${endY + radius}`,
    `V${BASE}Z`,
  ].join(" ");
}

function powerZone(power, scale) {
  if (!scale) return null;
  const zone = POWER_ZONE_LIMITS.findIndex((limit) => power / scale <= limit);
  return zone === -1 ? POWER_ZONE_LIMITS.length : zone;
}

function zoneGradient(id, y, maxPower, scale) {
  const gradient = svgElement("linearGradient", {
    id, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: BASE, y2: y(maxPower),
  });
  let start = 0;
  POWER_ZONE_DEFINITIONS.forEach(({ color }, index) => {
    const end = Math.min(1, (POWER_ZONE_LIMITS[index] ?? Infinity) * scale / maxPower);
    gradient.append(svgElement("stop", { offset: start, "stop-color": color }),
      svgElement("stop", { offset: end, "stop-color": color }));
    start = end;
  });
  return gradient;
}

function hatchMask(id) {
  const pattern = svgElement("pattern", {
    id: `${id}-pattern`, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(35)",
  });
  pattern.append(svgElement("path", { d: "M0 0V5", stroke: "white", "stroke-width": 2 }));
  const mask = svgElement("mask", { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: WIDTH, height: HEIGHT });
  mask.append(svgElement("rect", { width: WIDTH, height: HEIGHT, fill: `url(#${id}-pattern)` }));
  const group = svgElement("g");
  group.append(pattern, mask);
  return group;
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}
