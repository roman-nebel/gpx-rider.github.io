// Applies a hard road-speed ceiling and advance corner braking to speed and traveled distance.
import { minimumSpeedLimit, speedLimitAt } from "../route/speed-profile.mjs";

export function governMotion(wasLimited, previousSpeedKph, proposed, elapsedSeconds, roadMeters, profile, config) {
  const duration = Math.max(0, elapsedSeconds);
  const ceiling = Math.max(0, config.max_speed_kph);
  const startLimit = Math.min(ceiling, speedLimitAt(profile, roadMeters));
  if (!duration) {
    const speedKph = Math.min(proposed.speedKph, startLimit, wasLimited ? previousSpeedKph : Infinity);
    return { speedKph, distanceMeters: 0, limited: speedKph < proposed.speedKph };
  }
  const inferredStart = Math.max(0, 2 * proposed.distanceMeters / duration * 3.6 - proposed.speedKph);
  const high = Math.max(previousSpeedKph, inferredStart, proposed.speedKph);
  if (!wasLimited && high <= Math.min(ceiling, minimumSpeedLimit(profile, roadMeters, roadMeters + proposed.distanceMeters))) {
    return { ...proposed, limited: false };
  }
  let speed = Math.min(Math.max(0, previousSpeedKph), startLimit) / 3.6;
  let distanceMeters = 0;
  let limited = wasLimited;
  const count = Math.ceil(duration / config.integration_step_seconds);
  const dt = duration / count;
  for (let i = 0; i < count; i++) {
    const desired = Math.max(0, inferredStart + (proposed.speedKph - inferredStart) * (i + 1) / count) / 3.6;
    let next = Math.min(desired, ceiling / 3.6);
    if (limited && next > speed) next = Math.min(next, speed + config.recovery_acceleration_mps2 * dt);
    const predictedEnd = roadMeters + distanceMeters + (speed + next) / 2 * dt;
    next = Math.min(next, minimumSpeedLimit(profile, roadMeters + distanceMeters, predictedEnd) / 3.6);
    distanceMeters += (speed + next) / 2 * dt;
    speed = next;
    limited = next < desired - 1e-9;
  }
  return { speedKph: Math.min(ceiling, speed * 3.6), distanceMeters, limited };
}
