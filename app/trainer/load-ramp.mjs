// Ramps physical road load after measured effort resumes, independently of avatar speed.
import { clamp } from "../core/geo.mjs";

export function advanceRoadLoad(previous, powerWatts, elapsedSeconds, config) {
  if (!Number.isFinite(powerWatts) || powerWatts <= config.coasting_power_watts) return 0;
  if (config.trainer_load_ramp_seconds <= 0) return 1;
  return clamp(previous + Math.max(0, elapsedSeconds) / config.trainer_load_ramp_seconds, 0, 1);
}
