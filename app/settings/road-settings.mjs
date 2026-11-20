// Owns the shared road-physics settings and forwards road configuration to hardware.
import { state, els } from "../core/state.mjs";
import { ROAD_PHYSICS, SPEED_LIMITS, DEFAULT_MAX_RIDE_SPEED_KPH } from "../core/tuning.mjs";
import { clamp } from "../core/geo.mjs";
import { configureTrainerRoad, trainerRoadSupport } from "../trainer/trainer.mjs";
import { realRoadConfig, resetRoadMotion } from "../ride/road-speed.mjs";
import { updatePedalingFromSpeed } from "../ride/movement.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import { updateRideUi } from "../ride/ride-ui.mjs";

export function restoreRoadSettings(settings) {
  for (const [field, key, limits] of [
    ["riderWeightKg", "rider_weight_kg", ROAD_PHYSICS.rider_weight_limits],
    ["bikeWeightKg", "bike_weight_kg", ROAD_PHYSICS.bike_weight_limits],
  ]) {
    const value = settings?.[field];
    state[field] = Number.isFinite(value) ? clamp(value, limits.min, limits.max) : ROAD_PHYSICS[key];
  }
  state.maxRideSpeedKph = Number.isFinite(settings?.maxRideSpeedKph)
    ? clamp(settings.maxRideSpeedKph, SPEED_LIMITS.max_speed_limits_kph.min, SPEED_LIMITS.max_speed_limits_kph.max)
    : DEFAULT_MAX_RIDE_SPEED_KPH;
  if (typeof settings?.autoCornerBraking === "boolean") state.autoCornerBraking = settings.autoCornerBraking;
  if (typeof settings?.inertiaEnabled === "boolean") state.inertiaEnabled = settings.inertiaEnabled;
  applyRoadSettings();
}

export function updateRoadSettings() {
  const previousPhysics = [state.riderWeightKg, state.bikeWeightKg, state.inertiaEnabled];
  const mass = (input, limits, fallback) => input.value.trim() && Number.isFinite(Number(input.value))
    ? clamp(Number(input.value), limits.min, limits.max) : fallback;
  state.riderWeightKg = mass(els.riderWeightInput, ROAD_PHYSICS.rider_weight_limits, ROAD_PHYSICS.rider_weight_kg);
  state.bikeWeightKg = mass(els.bikeWeightInput, ROAD_PHYSICS.bike_weight_limits, ROAD_PHYSICS.bike_weight_kg);
  state.inertiaEnabled = els.inertiaInput.checked;
  state.maxRideSpeedKph = mass(els.maxRideSpeedInput, SPEED_LIMITS.max_speed_limits_kph, DEFAULT_MAX_RIDE_SPEED_KPH);
  state.autoCornerBraking = els.autoCornerBrakingInput.checked;
  const currentPhysics = [state.riderWeightKg, state.bikeWeightKg, state.inertiaEnabled];
  if (previousPhysics.some((value, i) => value !== currentPhysics[i])) resetRoadMotion();
  applyRoadSettings();
  updatePedalingFromSpeed();
  saveSettings();
  if (state.route.length) updateRideUi({ force: true });
}

function applyRoadSettings() {
  els.riderWeightInput.value = state.riderWeightKg;
  els.bikeWeightInput.value = state.bikeWeightKg;
  els.inertiaInput.checked = state.inertiaEnabled;
  els.maxRideSpeedInput.value = state.maxRideSpeedKph;
  els.maxRideSpeedInput.min = SPEED_LIMITS.max_speed_limits_kph.min;
  els.maxRideSpeedInput.max = SPEED_LIMITS.max_speed_limits_kph.max;
  els.autoCornerBrakingInput.checked = state.autoCornerBraking;
  for (const [input, limits] of [[els.riderWeightInput, ROAD_PHYSICS.rider_weight_limits], [els.bikeWeightInput, ROAD_PHYSICS.bike_weight_limits]]) {
    input.min = limits.min;
    input.max = limits.max;
  }
  configureTrainerRoad(realRoadConfig());
  updateRoadSupport();
}

export function updateRoadSupport() {
  els.trainerRoadSupport.textContent = trainerRoadSupport();
}
