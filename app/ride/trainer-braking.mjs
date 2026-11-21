// Converts active virtual braking into a bounded, ramped trainer brake-strength request.
import { clamp } from "../core/geo.mjs";

export function advanceTrainerBrake(previous, motion, config) {
  if (motion.erg || motion.pedaling !== true || motion.loadFraction <= 0 ||
      !Number.isFinite(motion.trainerSpeedKph)) return 0;
  const dt = Math.max(0, motion.elapsedSeconds);
  const atLimit = motion.speedKph >= motion.limitKph - config.trainer_brake_speed_band_kph;
  let target = 0;
  if (atLimit && (motion.limited || previous > 0)) {
    const excess = Math.max(0, motion.trainerSpeedKph - motion.limitKph - config.trainer_brake_speed_deadband_kph);
    const deceleration = dt > 0 ? Math.max(0, motion.previousSpeedKph - motion.speedKph) / 3.6 / dt : 0;
    target = clamp(Math.max(excess / config.trainer_brake_full_overspeed_kph,
      motion.limited ? deceleration / config.braking_deceleration_mps2 : 0), 0, 1);
    if (previous > 0 && motion.trainerSpeedKph >= motion.limitKph - config.trainer_brake_release_gap_kph) {
      target = Math.max(target, previous);
    }
  }
  const seconds = target > previous ? config.trainer_brake_engage_seconds : config.trainer_brake_release_seconds;
  const change = seconds > 0 ? dt / seconds : 1;
  return clamp(target, previous - change, previous + change);
}
