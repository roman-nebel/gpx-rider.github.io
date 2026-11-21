// Selects road or trainer speed by their gap and restores road load after a speed catch.
import { advanceCyclingMotion } from "./cycling-motion.mjs";

export function createFreewheel() {
  return { phase: "coupled", loadFraction: 1, holdSeconds: 0, coastSpeedKph: null };
}

export function advanceFreewheel(coupling, speedKph, {
  trainerSpeedKph, elapsedSeconds, gradePercent, config,
}) {
  const next = { ...coupling };
  const dt = Math.max(0, elapsedSeconds);
  // Keep the zero-power reference independent of small trainer-speed errors.
  // Resetting it to each raw sample would hide accumulated downhill gains or
  // flywheel deceleration whenever each individual frame's gap is small.
  const coast = advanceCyclingMotion(next.coastSpeedKph ?? speedKph, 0, gradePercent, dt, config);
  next.coastSpeedKph = coast.speedKph;
  const hasSpeed = Number.isFinite(trainerSpeedKph);
  const gap = hasSpeed ? coast.speedKph - trainerSpeedKph : Infinity;
  if (next.phase === "coupled") {
    if (hasSpeed && gap <= config.engagement_speed_tolerance_kph) {
      next.coastSpeedKph = Math.max(coast.speedKph, trainerSpeedKph);
      return { coupling: next, speedKph: trainerSpeedKph, distanceMeters: trainerSpeedKph / 3.6 * dt };
    }
    next.phase = "freewheel";
    next.loadFraction = 0;
    next.holdSeconds = 0;
  }
  if (next.phase === "freewheel") {
    const catching = hasSpeed && gap <= config.engagement_speed_tolerance_kph;
    next.holdSeconds = catching ? next.holdSeconds + dt : 0;
    if (catching && next.holdSeconds + Number.EPSILON >= config.engagement_hold_seconds) next.phase = "engaging";
    return { coupling: next, ...coast };
  }

  if (!hasSpeed || gap > config.engagement_release_gap_kph) {
    return { coupling: { ...next, phase: "freewheel", loadFraction: 0, holdSeconds: 0 }, ...coast };
  }

  const remaining = config.engagement_ramp_seconds * (1 - next.loadFraction);
  const weight = remaining > 0 ? Math.min(1, dt / remaining) : 1;
  const speed = coast.speedKph + (trainerSpeedKph - coast.speedKph) * weight;
  next.coastSpeedKph = speed;
  next.loadFraction = Math.min(1, next.loadFraction + dt / config.engagement_ramp_seconds);
  if (next.loadFraction >= 1) {
    next.phase = "coupled";
    next.holdSeconds = 0;
  }
  return { coupling: next, speedKph: speed, distanceMeters: (speedKph + speed) / 2 / 3.6 * dt };
}
