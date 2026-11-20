// Models a freewheel catching the road speed before restoring the trainer's road load.
import { advanceCyclingMotion } from "./cycling-motion.mjs";

export function createFreewheel() {
  return { phase: "coupled", loadFraction: 1, holdSeconds: 0 };
}

export function advanceFreewheel(coupling, speedKph, {
  trainerSpeedKph, pedaling, powerWatts, elapsedSeconds, gradePercent, config,
}) {
  const next = { ...coupling };
  const dt = Math.max(0, elapsedSeconds);
  if (pedaling === false) {
    next.phase = "freewheel";
    next.loadFraction = 0;
    next.holdSeconds = 0;
  }
  if (next.phase === "coupled") {
    const speed = trainerSpeedKph ?? 0;
    return { coupling: next, speedKph: speed, distanceMeters: speed / 3.6 * dt };
  }

  const coast = advanceCyclingMotion(speedKph, 0, gradePercent, dt, config);
  const hasSpeed = Number.isFinite(trainerSpeedKph);
  const gap = hasSpeed ? coast.speedKph - trainerSpeedKph : Infinity;
  if (next.phase === "freewheel") {
    const catching = pedaling === true && hasSpeed && gap <= config.engagement_speed_tolerance_kph;
    next.holdSeconds = catching ? next.holdSeconds + dt : 0;
    if (catching && next.holdSeconds + Number.EPSILON >= config.engagement_hold_seconds) next.phase = "engaging";
    return { coupling: next, ...coast };
  }

  if (!hasSpeed || pedaling !== true || gap > config.engagement_release_gap_kph) {
    return { coupling: { phase: "freewheel", loadFraction: 0, holdSeconds: 0 }, ...coast };
  }

  const remaining = config.engagement_ramp_seconds * (1 - next.loadFraction);
  const weight = remaining > 0 ? Math.min(1, dt / remaining) : 1;
  const motion = advanceCyclingMotion(speedKph, Math.max(0, powerWatts) * next.loadFraction, gradePercent, dt, config);
  const speed = motion.speedKph + (trainerSpeedKph - motion.speedKph) * weight;
  next.loadFraction = Math.min(1, next.loadFraction + dt / config.engagement_ramp_seconds);
  if (next.loadFraction >= 1) {
    next.phase = "coupled";
    next.holdSeconds = 0;
  }
  return { coupling: next, speedKph: speed, distanceMeters: (speedKph + speed) / 2 / 3.6 * dt };
}
