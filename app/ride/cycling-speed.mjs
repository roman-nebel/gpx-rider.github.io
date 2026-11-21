// Converts between steady road speed and power using gravity, rolling resistance, and drag.
import { cyclingForces } from "./cycling-motion.mjs";

const KPH_PER_MPS = 3.6;

function wheelPowerAtSpeed(speed, grade, config) {
  const force = cyclingForces(speed * KPH_PER_MPS, grade, config);
  return (force.gravityNewtons + force.rollingNewtons + force.dragNewtons) * speed;
}

export function cyclingPowerForSpeed(speedKph, gradePercent, config) {
  return Math.max(0, wheelPowerAtSpeed(Math.max(0, speedKph) / KPH_PER_MPS, gradePercent, config) / config.drivetrain_efficiency);
}

export function cyclingSpeedForPower(powerWatts, gradePercent, config) {
  const wheelPower = Math.max(0, powerWatts) * config.drivetrain_efficiency;
  const force = cyclingForces(0, gradePercent, config);
  if (!wheelPower && force.gravityNewtons + force.rollingNewtons + force.dragNewtons >= 0) return config.min_speed_kph;

  let low = config.min_speed_kph / KPH_PER_MPS;
  const ceiling = config.max_speed_kph / KPH_PER_MPS;
  let high = Math.min(ceiling, Math.max(1, low * 2));
  // ERG has no user speed cap: expand the numerical bracket to the physical
  // drag equilibrium instead of reusing the free-ride speed ceiling.
  for (let i = 0; i < 64 && high < ceiling && wheelPowerAtSpeed(high, gradePercent, config) < wheelPower; i++) {
    high = Math.min(ceiling, high * 2);
  }
  for (let i = 0; i < 34; i += 1) {
    const speed = (low + high) / 2;
    const requiredPower = wheelPowerAtSpeed(speed, gradePercent, config);
    if (requiredPower > wheelPower) high = speed;
    else low = speed;
  }
  return ((low + high) / 2) * KPH_PER_MPS;
}
