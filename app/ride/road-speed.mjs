// Owns measured-power road motion, physical trainer load, and display-only finish rollout.
import { state } from "../core/state.mjs";
import { ROAD_PHYSICS, SPEED_LIMITS } from "../core/tuning.mjs";
import { advanceCyclingMotion } from "./cycling-motion.mjs";
import { cyclingSpeedForPower } from "./cycling-speed.mjs";
import { advanceRoadLoad } from "../trainer/load-ramp.mjs";
import { setTrainerRoadLoad } from "../trainer/trainer.mjs";
import { workoutTargetWatts } from "../workout/workout-step.mjs";
import { governMotion } from "./speed-governor.mjs";
import { speedLimitConfig, turnSpeedProfile } from "./speed-limits.mjs";
import { advanceTrainerBrake } from "./trainer-braking.mjs";
import { speedLimitAt } from "../route/speed-profile.mjs";
import { roadDistanceAt } from "../route/route.mjs";

export function realRoadConfig() {
  // Limits are applied after physical integration, so excess acceleration
  // remains available to the governor and the physical braking controller.
  return { ...ROAD_PHYSICS, rider_weight_kg: state.riderWeightKg, bike_weight_kg: state.bikeWeightKg, max_speed_kph: Infinity };
}

export function trainerEffort(now = performance.now()) {
  const fresh = (at) => Number.isFinite(at) && now - at <= ROAD_PHYSICS.telemetry_timeout_ms;
  const cadence = fresh(state.trainerCadenceSampleAt) && Number.isFinite(state.trainerCadenceRpm) ? state.trainerCadenceRpm : null;
  const power = fresh(state.trainerPowerSampleAt) && Number.isFinite(state.trainerPowerWatts) ? state.trainerPowerWatts : null;
  const active = cadence !== null ? cadence > 0 : power !== null ? power > ROAD_PHYSICS.coasting_power_watts : null;
  return { cadence, power, active };
}

export function realRoadMoving() {
  if (state.simulatorEnabled || state.roadFinished) return false;
  const { power } = trainerEffort();
  return power !== null && (power > 0 || state.roadSpeedKph > ROAD_PHYSICS.stop_speed_kph);
}

export function realErgPowerStep() {
  const session = state.workoutErg;
  if (!state.workoutErgEnabled || !session || session.paused) return false;
  const step = session.steps?.[session.index];
  return step ? workoutTargetWatts(step, state.ftpWatts, session.elapsed) > 0 : session.targetWatts > 0;
}

export function prepareRealRoadMotion(effort) {
  const erg = realErgPowerStep();
  if (effort.power === null) {
    resetRoadMotion({ loadFraction: erg ? 1 : 0 });
    return;
  }
  state.roadCoasting = effort.power <= ROAD_PHYSICS.coasting_power_watts;
  if (erg || !state.inertiaEnabled || state.roadCoasting) {
    state.trainerLoadFraction = erg || !state.roadCoasting ? 1 : 0;
    if (erg || state.roadCoasting) state.trainerBrakeStrength = 0;
    state.trainerUphillGradePercent = 0;
    void setTrainerRoadLoad(state.trainerLoadFraction, state.trainerBrakeStrength, undefined, 0);
  }
}

export function finishRoadMotion(simulation = null) {
  state.roadFinishConfig = { ...(simulation?.config ?? realRoadConfig()), max_speed_kph: Infinity };
  if (simulation) state.roadSpeedKph = simulation.model.speedKph;
  state.roadFinished = true;
  state.roadCoasting = false;
  state.trainerBrakeStrength = 0;
  state.trainerUphillGradePercent = 0;
  if (!simulation) void setTrainerRoadLoad(state.trainerLoadFraction, 0, 0, 0);
}

// Rollout is display-only: no route distance, activity samples, or pedal power
// are added after the ride ends. Use level ground with the captured rider mass.
export function advanceFinishedRoadSpeed(elapsedSeconds) {
  const config = state.roadFinishConfig ?? realRoadConfig();
  const motion = advanceCyclingMotion(state.roadSpeedKph ?? 0, 0, 0, elapsedSeconds, config);
  state.roadSpeedKph = motion.speedKph > ROAD_PHYSICS.stop_speed_kph ? motion.speedKph : 0;
}

export function resetRoadMotion({ loadFraction = 1 } = {}) {
  state.roadFinished = false;
  state.roadFinishConfig = null;
  state.roadSpeedKph = null;
  state.roadCoasting = false;
  state.trainerLoadFraction = loadFraction;
  state.roadSpeedLimited = false;
  state.trainerBrakeStrength = 0;
  state.trainerUphillGradePercent = 0;
  void setTrainerRoadLoad(loadFraction, 0, undefined, 0);
}

export function advanceRealRoadSpeed(elapsedSeconds, grade, now) {
  const effort = trainerEffort(now);
  const erg = realErgPowerStep();
  if (effort.power === null) {
    resetRoadMotion({ loadFraction: erg ? 1 : 0 });
    return { speedKph: 0, distanceMeters: 0 };
  }
  const config = realRoadConfig();
  const power = Math.max(0, effort.power);
  const previous = state.roadSpeedKph ?? 0;
  let motion;
  if (state.inertiaEnabled) {
    motion = advanceCyclingMotion(previous, power, grade, elapsedSeconds, config);
  } else {
    const speedKph = cyclingSpeedForPower(power, grade, config);
    motion = { speedKph, distanceMeters: speedKph / 3.6 * elapsedSeconds };
  }
  const roadMeters = roadDistanceAt(state.route, state.progressMeters);
  const profile = erg ? null : turnSpeedProfile();
  const governed = erg ? { ...motion, limited: false }
    : governMotion(state.roadSpeedLimited, previous, motion, elapsedSeconds, roadMeters, profile, speedLimitConfig());
  state.roadCoasting = power <= ROAD_PHYSICS.coasting_power_watts;
  if (erg || !state.inertiaEnabled) {
    state.trainerLoadFraction = erg || !state.roadCoasting ? 1 : 0;
    state.trainerUphillGradePercent = 0;
  } else {
    const speedFresh = Number.isFinite(state.trainerSpeedSampleAt) &&
      (now ?? performance.now()) - state.trainerSpeedSampleAt <= config.telemetry_timeout_ms;
    const load = advanceRoadLoad({ fraction: state.trainerLoadFraction, uphillGradePercent: state.trainerUphillGradePercent }, {
      powerWatts: power, trainerSpeedKph: speedFresh ? state.trainerSpeedKph : null,
      roadSpeedKph: governed.speedKph, gradePercent: grade,
    }, elapsedSeconds, config);
    state.trainerLoadFraction = load.fraction;
    state.trainerUphillGradePercent = load.uphillGradePercent;
  }
  state.trainerBrakeStrength = advanceTrainerBrake(state.trainerBrakeStrength, {
    erg, driving: !state.roadCoasting, loadFraction: state.trainerLoadFraction,
    speedKph: governed.speedKph, previousSpeedKph: previous, unlimitedSpeedKph: motion.speedKph,
    limitKph: Math.min(state.maxRideSpeedKph, speedLimitAt(profile, roadMeters + governed.distanceMeters)),
    limited: governed.limited, elapsedSeconds,
  }, SPEED_LIMITS);
  state.roadSpeedLimited = governed.limited;
  state.roadSpeedKph = governed.speedKph;
  void setTrainerRoadLoad(state.trainerLoadFraction, state.trainerBrakeStrength, undefined, state.trainerUphillGradePercent);
  return { speedKph: governed.speedKph, distanceMeters: governed.distanceMeters };
}
