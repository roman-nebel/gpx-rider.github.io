// Adapts trainer telemetry to road motion and freewheel engagement outside ERG.
import { state } from "../core/state.mjs";
import { ROAD_PHYSICS, SPEED_LIMITS } from "../core/tuning.mjs";
import { advanceCyclingMotion } from "./cycling-motion.mjs";
import { cyclingSpeedForPower } from "./cycling-speed.mjs";
import { advanceFreewheel, createFreewheel } from "./freewheel.mjs";
import { setTrainerRoadLoad } from "../trainer/trainer.mjs";
import { workoutTargetWatts } from "../workout/workout-step.mjs";
import { governMotion } from "./speed-governor.mjs";
import { speedLimitConfig, turnSpeedProfile } from "./speed-limits.mjs";
import { advanceTrainerBrake } from "./trainer-braking.mjs";
import { speedLimitAt } from "../route/speed-profile.mjs";
import { roadDistanceAt } from "../route/route.mjs";

export function realRoadConfig() {
  return { ...ROAD_PHYSICS, rider_weight_kg: state.riderWeightKg, bike_weight_kg: state.bikeWeightKg, max_speed_kph: realErgPowerStep() ? Infinity : state.maxRideSpeedKph };
}

export function trainerEffort(now = performance.now()) {
  const fresh = (at) => at !== null && now - at <= ROAD_PHYSICS.telemetry_timeout_ms;
  const cadence = fresh(state.trainerCadenceSampleAt) ? state.trainerCadenceRpm : null;
  const power = fresh(state.trainerPowerSampleAt) ? state.trainerPowerWatts : null;
  const speed = fresh(state.trainerSpeedSampleAt) ? state.trainerSpeedKph : null;
  const active = cadence !== null ? cadence > 0 : power !== null ? power > ROAD_PHYSICS.coasting_power_watts : null;
  return { cadence, power, speed, active, fresh: cadence !== null || power !== null || speed !== null };
}

export function realCoasting() {
  return !state.simulatorEnabled && state.inertiaEnabled && state.roadCoasting &&
    state.roadSpeedKph > ROAD_PHYSICS.stop_speed_kph;
}

export function realErgPowerStep() {
  const session = state.workoutErg;
  if (!session || session.paused) return false;
  const step = session.steps?.[session.index];
  return step ? workoutTargetWatts(step, state.ftpWatts, session.elapsed) > 0 : session.targetWatts > 0;
}

export function prepareRealRoadMotion(effort) {
  const erg = realErgPowerStep();
  state.roadCoupling ??= createFreewheel();
  if (!state.inertiaEnabled || erg) {
    state.roadCoupling = createFreewheel();
    state.roadCoasting = state.inertiaEnabled && effort.active === false;
    if (erg) state.trainerBrakeStrength = 0;
    void setTrainerRoadLoad(1, erg ? 0 : state.trainerBrakeStrength);
  } else if (effort.active === false) {
    state.roadCoupling = { phase: "freewheel", loadFraction: 0, holdSeconds: 0 };
    state.roadCoasting = true;
    state.trainerBrakeStrength = 0;
    void setTrainerRoadLoad(0, 0);
  } else {
    state.roadCoasting = state.roadCoupling.phase !== "coupled";
  }
  if (effort.active && !erg && !state.roadCoasting && effort.speed !== null && state.roadSpeedKph === null) state.roadSpeedKph = effort.speed;
}

export function finishRealRoadMotion() {
  state.trainerBrakeStrength = 0;
  // Apply the finish grade and brake release together, preserving minimum
  // resistance if the rider crosses the finish while freewheeling.
  void setTrainerRoadLoad(state.roadCoupling?.loadFraction ?? 1, 0, 0);
}

export function resetRoadMotion() {
  state.roadSpeedKph = null;
  state.roadCoasting = false;
  state.roadCoupling = createFreewheel();
  state.ergRoadSpeedKph = null;
  state.roadSpeedLimited = false;
  state.trainerBrakeStrength = 0;
  void setTrainerRoadLoad(1, 0);
}

export function advanceRealRoadSpeed(elapsedSeconds, grade, now) {
  const effort = trainerEffort(now);
  if (!effort.fresh) {
    resetRoadMotion();
    return { speedKph: 0, distanceMeters: 0 };
  }
  const erg = realErgPowerStep();
  const config = realRoadConfig();
  const coasting = state.inertiaEnabled && effort.active === false;
  const previous = state.roadSpeedKph ?? (coasting ? effort.speed ?? 0 : 0);
  let result;
  if (state.inertiaEnabled && !erg) {
    const freewheel = advanceFreewheel(state.roadCoupling ?? createFreewheel(), previous, {
      trainerSpeedKph: effort.speed, pedaling: effort.active, powerWatts: effort.power ?? 0,
      elapsedSeconds, gradePercent: grade, config,
    });
    state.roadCoupling = freewheel.coupling;
    state.roadCoasting = freewheel.coupling.phase !== "coupled";
    result = { speedKph: freewheel.speedKph, distanceMeters: freewheel.distanceMeters };
  } else if (state.inertiaEnabled && erg) {
    result = advanceCyclingMotion(previous, coasting ? 0 : effort.power ?? 0, grade, elapsedSeconds, config);
  } else {
    const speedKph = erg
      ? cyclingSpeedForPower(effort.power ?? 0, grade, config)
      : effort.speed ?? 0;
    result = { speedKph, distanceMeters: speedKph / 3.6 * elapsedSeconds };
  }
  const roadMeters = roadDistanceAt(state.route, state.progressMeters);
  const profile = erg ? null : turnSpeedProfile();
  const governed = erg ? { ...result, limited: false }
    : governMotion(state.roadSpeedLimited, previous, result, elapsedSeconds, roadMeters, profile, speedLimitConfig());
  state.trainerBrakeStrength = advanceTrainerBrake(state.trainerBrakeStrength, {
    erg, pedaling: effort.active, loadFraction: state.roadCoupling?.loadFraction ?? 1,
    speedKph: governed.speedKph, previousSpeedKph: previous, trainerSpeedKph: effort.speed,
    limitKph: Math.min(state.maxRideSpeedKph, speedLimitAt(profile, roadMeters + governed.distanceMeters)),
    limited: governed.limited, elapsedSeconds,
  }, SPEED_LIMITS);
  state.roadSpeedLimited = governed.limited;
  result = { speedKph: governed.speedKph, distanceMeters: governed.distanceMeters };
  state.roadSpeedKph = result.speedKph;
  state.ergRoadSpeedKph = erg ? result.speedKph : null;
  if (erg || !state.inertiaEnabled) {
    state.roadCoasting = coasting;
    state.roadCoupling = createFreewheel();
  }
  void setTrainerRoadLoad(state.roadCoupling?.loadFraction ?? 1, state.trainerBrakeStrength);
  return result;
}
