// Computes road forces and integrates longitudinal motion, including zero-power coasting.
import { clamp } from "../core/geo.mjs";

const GRAVITY = 9.80665;

export function cyclingForces(speedKph, gradePercent, config) {
  const mass = config.rider_weight_kg + config.bike_weight_kg;
  const grade = (Number.isFinite(gradePercent) ? gradePercent : 0) / 100;
  const cosine = 1 / Math.hypot(1, grade);
  const airSpeed = speedKph / 3.6 + (config.wind_speed_mps ?? 0);
  return {
    gravityNewtons: mass * GRAVITY * grade * cosine,
    rollingNewtons: mass * GRAVITY * config.rolling_resistance_coefficient * cosine,
    dragNewtons: 0.5 * config.air_density_kg_per_cubic_meter * config.drag_area_square_meters * airSpeed * Math.abs(airSpeed),
  };
}

export function advanceCyclingMotion(speedKph, powerWatts, gradePercent, elapsedSeconds, config) {
  let speed = Math.min(config.max_speed_kph, Math.max(0, speedKph)) / 3.6;
  let distanceMeters = 0;
  const duration = Math.max(0, elapsedSeconds);
  const count = Math.ceil(duration / config.integration_step_seconds);
  const dt = count ? duration / count : 0;
  const mass = config.rider_weight_kg + config.bike_weight_kg;
  const power = Math.max(0, powerWatts) * config.drivetrain_efficiency;
  for (let step = 0; step < count; step++) {
    // Backward Euler solves the next speed implicitly. Its monotonic residual
    // stays stable at rest and under heavy braking; substeps limit integration
    // error. The launch speed bounds drive force near the P/v singularity.
    const residual = (next) => {
      const forces = cyclingForces(next * 3.6, gradePercent, config);
      const drive = power / Math.max(next, config.launch_speed_mps);
      return next - speed - dt / mass * (drive - forces.gravityNewtons - forces.rollingNewtons - forces.dragNewtons);
    };
    let next = 0;
    if (residual(0) < 0) {
      let low = 0;
      const atRest = cyclingForces(0, gradePercent, config);
      // At-rest drive minus road force bounds acceleration from above. This
      // supplies a finite solver bracket even when ERG has no speed ceiling.
      const upper = speed + dt / mass * (power / config.launch_speed_mps -
        atRest.gravityNewtons - atRest.rollingNewtons - atRest.dragNewtons);
      let high = Math.min(config.max_speed_kph / 3.6, Math.max(speed, upper));
      for (let iteration = 0; iteration < 36; iteration++) {
        const middle = (low + high) / 2;
        if (residual(middle) > 0) high = middle;
        else low = middle;
      }
      next = clamp((low + high) / 2, 0, config.max_speed_kph / 3.6);
    }
    if (next === 0 && speed > 0) {
      const f = cyclingForces(0, gradePercent, config);
      const braking = f.gravityNewtons + f.rollingNewtons + f.dragNewtons - power / config.launch_speed_mps;
      const stoppingTime = braking > 0 ? Math.min(dt, speed * mass / braking) : dt;
      distanceMeters += speed * stoppingTime / 2;
    } else {
      distanceMeters += (speed + next) / 2 * dt;
    }
    speed = next;
  }
  return { speedKph: speed * 3.6, distanceMeters };
}
