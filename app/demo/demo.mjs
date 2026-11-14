// Models a virtual rider's power, speed, cadence, heart rate, and energy use.
import { clamp, roundCoordinate } from "../core/geo.mjs";
import { CYCLING_GROSS_EFFICIENCY, DEMO_RIDE } from "../core/tuning.mjs";
import { cyclingSpeedForPower } from "../ride/cycling-speed.mjs";
import { activeCaloriesFromPower } from "../core/units.mjs";

export function createDemoRideModel(config = DEMO_RIDE) {
  return {
    elapsedSeconds: 0,
    speedKph: 0,
    powerWatts: config.flat_power_watts,
    cadenceRpm: config.flat_cadence_rpm,
    cadenceNoiseRpm: 0,
    heartRateCoreBpm: config.resting_heart_rate_bpm,
    heartRateBpm: config.resting_heart_rate_bpm,
    lastHeartRateUpdateSeconds: -Infinity,
    heartRateNoiseBpm: 0,
    fallDelaySeconds: 0,
    lowEffortSeconds: 0,
    caloriesKcal: 0,
    distanceMeters: 0,
    historySamples: [],
  };
}

export function demoTargetPowerWatts(gradePercent, config = DEMO_RIDE) {
  const grade = Number.isFinite(gradePercent) ? gradePercent : 0;
  const watts = grade >= 0
    ? config.flat_power_watts + grade * config.climb_watts_per_grade_percent
    : config.flat_power_watts + grade * config.descent_watts_per_grade_percent;
  return clamp(watts, config.min_power_watts, config.max_power_watts);
}

export function demoTargetCadenceRpm(gradePercent, config = DEMO_RIDE) {
  const grade = Number.isFinite(gradePercent) ? gradePercent : 0;
  const rpm = config.flat_cadence_rpm + grade * config.cadence_rpm_per_grade_percent;
  return clamp(rpm, config.min_cadence_rpm, config.max_cadence_rpm);
}

export function demoSpeedForPower(powerWatts, gradePercent, config = DEMO_RIDE) {
  return cyclingSpeedForPower(powerWatts, gradePercent, config);
}

export function advanceDemoRide(model, {
  elapsedSeconds,
  gradePercent,
  targetPowerWatts = null,
  config = DEMO_RIDE,
}) {
  const dt = Math.max(0, elapsedSeconds);
  model.elapsedSeconds += dt;

  const freeRidePower = demoTargetPowerWatts(gradePercent, config);
  const previousPower = model.powerWatts;
  model.powerWatts = targetPowerWatts ?? smoothToward(
    previousPower, freeRidePower, dt, config.power_smoothing_tau_seconds,
  );

  const targetSpeedKph = demoSpeedForPower(model.powerWatts, gradePercent, config);
  model.speedKph = smoothToward(model.speedKph || targetSpeedKph, targetSpeedKph, dt, config.speed_smoothing_tau_seconds);

  let targetCadenceRpm = demoTargetCadenceRpm(gradePercent, config);
  if (targetPowerWatts !== null) {
    targetCadenceRpm *= Math.pow(model.powerWatts / freeRidePower, config.workout_cadence_power_exponent);
  }
  model.cadenceRpm = smoothToward(model.cadenceRpm, targetCadenceRpm, dt, config.cadence_smoothing_tau_seconds);
  model.cadenceNoiseRpm = (Math.random() * 2 - 1) * config.cadence_noise_rpm;
  const energyPower = targetPowerWatts ?? (previousPower + model.powerWatts) / 2;
  model.caloriesKcal += activeCaloriesFromPower(energyPower, dt, CYCLING_GROSS_EFFICIENCY);
  updateDemoHeartRate(model, dt, config);

  return {
    speedKph: Math.round(model.speedKph * 10) / 10,
    powerWatts: Math.round(model.powerWatts),
    cadenceRpm: model.powerWatts === 0 ? 0 : Math.round(clamp(
      model.cadenceRpm + model.cadenceNoiseRpm, config.min_cadence_rpm, config.max_cadence_rpm,
    )),
    heartRateBpm: Math.round(model.heartRateBpm),
  };
}

export function sampleDemoRide(model, {
  point, routeProgressMeters, metersAdvanced, telemetry, nowSeconds = Date.now() / 1000, config = DEMO_RIDE,
}) {
  model.distanceMeters += metersAdvanced;
  const timestamp = Math.floor(nowSeconds);
  if (model.historySamples.at(-1)?.t === timestamp) return;
  model.historySamples.push({
    t: timestamp,
    lat: roundCoordinate(point.lat),
    lng: roundCoordinate(point.lng),
    ele: point.ele,
    distance: model.distanceMeters,
    ...telemetry,
    caloriesKcal: model.caloriesKcal,
    routeProgressMeters,
  });
  if (model.historySamples.length > config.max_history_samples) model.historySamples.shift();
}

function updateDemoHeartRate(model, elapsedSeconds, config) {
  const effortRatio = clamp(model.powerWatts / config.ftp_watts, 0, 1.45);
  const thresholdReserve = config.threshold_heart_rate_bpm - config.resting_heart_rate_bpm;
  const targetAtEffort = effortRatio <= 1
    ? config.resting_heart_rate_bpm + thresholdReserve * Math.pow(effortRatio, 0.86)
    : config.threshold_heart_rate_bpm + (config.max_heart_rate_bpm - config.threshold_heart_rate_bpm) * clamp((effortRatio - 1) / 0.45, 0, 1);
  const lowEffortTarget = config.resting_heart_rate_bpm + 7;

  model.lowEffortSeconds = model.powerWatts <= config.min_power_watts + 25
    ? model.lowEffortSeconds + elapsedSeconds
    : 0;
  const target = model.lowEffortSeconds >= config.low_effort_return_delay_seconds
    ? config.resting_heart_rate_bpm
    : targetAtEffort;

  if (target >= model.heartRateCoreBpm) {
    model.fallDelaySeconds = 0;
    model.heartRateCoreBpm = smoothToward(model.heartRateCoreBpm, target, elapsedSeconds, config.heart_rate_rise_tau_seconds);
  } else {
    model.fallDelaySeconds += elapsedSeconds;
    if (model.fallDelaySeconds >= config.heart_rate_fall_delay_seconds || target <= lowEffortTarget) {
      model.heartRateCoreBpm = smoothToward(model.heartRateCoreBpm, target, elapsedSeconds, config.heart_rate_fall_tau_seconds);
    }
  }

  if (model.elapsedSeconds - model.lastHeartRateUpdateSeconds >= config.heart_rate_update_interval_seconds) {
    model.lastHeartRateUpdateSeconds = model.elapsedSeconds;
    model.heartRateNoiseBpm = (Math.random() * 2 - 1) * config.heart_rate_noise_bpm;
    model.heartRateBpm = clamp(
      model.heartRateCoreBpm + model.heartRateNoiseBpm,
      config.resting_heart_rate_bpm,
      config.max_heart_rate_bpm,
    );
  }
}

function smoothToward(current, target, elapsedSeconds, tauSeconds) {
  if (!Number.isFinite(current) || tauSeconds <= 0) return target;
  if (elapsedSeconds <= 0) return current;
  const alpha = 1 - Math.exp(-elapsedSeconds / tauSeconds);
  return current + (target - current) * alpha;
}
