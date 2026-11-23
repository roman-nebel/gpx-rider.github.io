// Owns the shared speed-limit settings adapter and caches the current route's corner envelope.
import { state } from "../core/state.mjs";
import { SPEED_LIMITS } from "../core/tuning.mjs";
import { roadDistanceAt } from "../route/route.mjs";
import { buildTurnSpeedProfile, speedLimitAt } from "../route/speed-profile.mjs";

export function speedLimitConfig() {
  return { ...SPEED_LIMITS, max_speed_kph: state.maxRideSpeedKph };
}

export function turnSpeedProfile() {
  if (state.speedLimitRoute !== state.route) {
    state.speedLimitRoute = state.route;
    state.turnSpeedProfile = null;
  }
  if (!state.autoCornerBraking) return null;
  state.turnSpeedProfile ??= buildTurnSpeedProfile(state.route, SPEED_LIMITS);
  return state.turnSpeedProfile;
}

export function currentSpeedLimit() {
  return Math.min(state.maxRideSpeedKph, speedLimitAt(turnSpeedProfile(), roadDistanceAt(state.route, state.progressMeters)));
}
