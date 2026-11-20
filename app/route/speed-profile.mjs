// Builds a smoothed curvature speed envelope with braking distance before each bend.
import { bearing, haversine, toRad } from "../core/geo.mjs";
import { interpolateRoutePoint, roadDistanceAt, routeTotalDistance } from "./route.mjs";

const GRAVITY = 9.80665;

export function buildTurnSpeedProfile(route, config) {
  const total = routeTotalDistance(route);
  if (route.length < 2 || total <= 0) return [];
  const step = Math.max(config.sample_step_meters, total / config.max_samples);
  const count = Math.ceil(total / step);
  const samples = [];
  let previous;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= count; i++) {
    const progress = Math.min(total, i * step);
    const point = interpolateRoutePoint(route, progress);
    if (previous) {
      const meters = haversine(previous, point);
      const angle = toRad(bearing(previous, point));
      x += meters * Math.sin(angle);
      y += meters * Math.cos(angle);
    }
    samples.push({ x, y, distanceMeters: roadDistanceAt(route, progress) });
    previous = point;
  }
  const prefixX = [0];
  const prefixY = [0];
  for (const point of samples) {
    prefixX.push(prefixX.at(-1) + point.x);
    prefixY.push(prefixY.at(-1) + point.y);
  }
  const half = Math.floor(config.smoothing_radius_meters / step);
  const smooth = samples.map((point, i) => {
    const low = Math.max(0, i - half);
    const high = Math.min(samples.length, i + half + 1);
    return { x: (prefixX[high] - prefixX[low]) / (high - low), y: (prefixY[high] - prefixY[low]) / (high - low) };
  });
  const span = Math.max(1, Math.min(Math.round(config.curvature_span_meters / step), Math.floor(count / 2)));
  const lateral = GRAVITY * Math.tan(toRad(config.max_lean_degrees));
  const ceiling = (config.max_speed_limits_kph.max / 3.6) ** 2;
  const profile = samples.map((point, i) => {
    let speedSquared = ceiling;
    if (i >= span && i + span < samples.length) {
      const a = smooth[i - span];
      const b = smooth[i];
      const c = smooth[i + span];
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const vx = c.x - b.x;
      const vy = c.y - b.y;
      const left = Math.hypot(ux, uy);
      const right = Math.hypot(vx, vy);
      if (left > 1e-6 && right > 1e-6) {
        const angle = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
        if (angle >= toRad(config.minimum_turn_angle_degrees)) {
          const radius = Math.max(config.minimum_turn_radius_meters, (left + right) / (4 * Math.sin(angle / 2)));
          speedSquared = Math.min(ceiling, lateral * radius);
        }
      }
    }
    return { distanceMeters: point.distanceMeters, speedSquared };
  });
  // v_start² <= v_end² + 2*a*distance. Back-propagation anticipates every
  // upcoming bend instead of braking only when the rider reaches its apex.
  for (let i = profile.length - 2; i >= 0; i--) {
    const distance = Math.max(0, profile[i + 1].distanceMeters - profile[i].distanceMeters);
    profile[i].speedSquared = Math.min(profile[i].speedSquared,
      profile[i + 1].speedSquared + 2 * config.braking_deceleration_mps2 * distance);
  }
  return profile;
}

function interval(profile, distance) {
  let low = 0;
  let high = profile.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (profile[middle].distanceMeters <= distance) low = middle;
    else high = middle;
  }
  return low;
}

export function speedLimitAt(profile, distance) {
  if (!profile?.length) return Infinity;
  if (distance <= profile[0].distanceMeters) return Math.sqrt(profile[0].speedSquared) * 3.6;
  if (distance >= profile.at(-1).distanceMeters) return Math.sqrt(profile.at(-1).speedSquared) * 3.6;
  const index = interval(profile, distance);
  const from = profile[index];
  const to = profile[index + 1];
  const ratio = (distance - from.distanceMeters) / (to.distanceMeters - from.distanceMeters || 1);
  return Math.sqrt(from.speedSquared + (to.speedSquared - from.speedSquared) * ratio) * 3.6;
}

export function minimumSpeedLimit(profile, from, to) {
  let minimum = Math.min(speedLimitAt(profile, from), speedLimitAt(profile, to));
  if (!profile?.length) return minimum;
  for (let i = interval(profile, from) + 1; i < profile.length && profile[i].distanceMeters < to; i++) {
    minimum = Math.min(minimum, Math.sqrt(profile[i].speedSquared) * 3.6);
  }
  return minimum;
}
