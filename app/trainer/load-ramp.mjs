// Couples physical road load to flywheel speed without altering calculated road motion.
import { clamp } from "../core/geo.mjs";

const GRAVITY = 9.80665;
const KPH_PER_MPS = 3.6;

export function advanceRoadLoad(previous, motion, elapsedSeconds, config) {
  const { powerWatts, trainerSpeedKph, roadSpeedKph, gradePercent } = motion;
  if (!Number.isFinite(powerWatts) || powerWatts <= config.coasting_power_watts ||
      !Number.isFinite(trainerSpeedKph) || !Number.isFinite(roadSpeedKph)) {
    return { fraction: 0, uphillGradePercent: 0 };
  }
  const gap = roadSpeedKph - Math.max(0, trainerSpeedKph);
  const threshold = previous.fraction > 0 ? config.trainer_catchup_release_kph : config.trainer_catchup_engage_kph;
  if (gap > threshold) return { fraction: 0, uphillGradePercent: 0 };
  const dt = Math.max(0, elapsedSeconds);
  const fraction = config.trainer_load_ramp_seconds > 0
    ? clamp(previous.fraction + dt / config.trainer_load_ramp_seconds, 0, 1) : 1;
  if (!(gradePercent > 0)) return { fraction, uphillGradePercent: 0 };
  // Close uphill flywheel overspeed with a bounded extra braking acceleration.
  // Convert a/g to an equivalent grade request; this is hardware feedback,
  // never another gravity or inertia term in the avatar's energy balance.
  const overspeed = Math.max(0, -gap - config.trainer_uphill_deadband_kph) / KPH_PER_MPS;
  const target = clamp(overspeed / config.trainer_uphill_correction_seconds / GRAVITY * 100,
    0, config.trainer_uphill_max_grade_percent);
  const change = dt * config.trainer_uphill_grade_rate_per_second;
  const uphillGradePercent = clamp(target, previous.uphillGradePercent - change, previous.uphillGradePercent + change);
  return { fraction, uphillGradePercent };
}
