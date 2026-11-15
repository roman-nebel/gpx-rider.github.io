// Converts between steady road speed and power using gravity, rolling resistance, and drag.
import { clamp } from "../core/geo.mjs";

const GRAVITY = 9.80665;
const KPH_PER_MPS = 3.6;

function roadLoad(gradePercent, config) {
  const massKg = config.rider_weight_kg + config.bike_weight_kg;
  const grade = clamp((Number.isFinite(gradePercent) ? gradePercent : 0) / 100, -0.3, 0.3);
  const slopeCos = 1 / Math.hypot(1, grade);
  const roadForce = massKg * GRAVITY * (grade + config.rolling_resistance_coefficient * slopeCos);
  const drag = 0.5 * config.air_density_kg_per_cubic_meter * config.drag_area_square_meters;
  return { roadForce, drag };
}

function wheelPowerAtSpeed(speed, roadForce, drag) {
  return (roadForce + drag * speed * speed) * speed;
}

export function cyclingPowerForSpeed(speedKph, gradePercent, config) {
  const { roadForce, drag } = roadLoad(gradePercent, config);
  const wheelPower = wheelPowerAtSpeed(Math.max(0, speedKph) / KPH_PER_MPS, roadForce, drag);
  return Math.max(0, wheelPower / config.drivetrain_efficiency);
}

export function cyclingSpeedForPower(powerWatts, gradePercent, config) {
  const wheelPower = Math.max(0, powerWatts) * config.drivetrain_efficiency;
  const { roadForce, drag } = roadLoad(gradePercent, config);
  if (!wheelPower && roadForce >= 0) return config.min_speed_kph;

  let low = config.min_speed_kph / KPH_PER_MPS;
  let high = config.max_speed_kph / KPH_PER_MPS;
  for (let i = 0; i < 34; i += 1) {
    const speed = (low + high) / 2;
    const requiredPower = wheelPowerAtSpeed(speed, roadForce, drag);
    if (requiredPower > wheelPower) high = speed;
    else low = speed;
  }
  return ((low + high) / 2) * KPH_PER_MPS;
}
