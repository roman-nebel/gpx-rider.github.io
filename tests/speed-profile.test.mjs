import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnSpeedProfile, speedLimitAt, minimumSpeedLimit } from "../app/route/speed-profile.mjs";
import { destinationPoint } from "../app/core/geo.mjs";
import { enrichRoute } from "../app/route/route.mjs";

const config = { sample_step_meters: 2, smoothing_radius_meters: 4, curvature_span_meters: 10,
  minimum_turn_angle_degrees: 3, minimum_turn_radius_meters: 3, max_lean_degrees: 20,
  braking_deceleration_mps2: 2, max_samples: 100000, max_speed_limits_kph: { min: 10, max: 120 } };
const origin = { lat: 50, lng: 14 };
const point = (x, y) => ({ ...destinationPoint(destinationPoint(origin, 90, x), 0, y), ele: 100 });

test("a straight GPX route does not introduce corner braking", () => {
  const route = enrichRoute(Array.from({ length: 101 }, (_, i) => point(i * 5, 0)));
  const plan = buildTurnSpeedProfile(route, config);
  assert.ok(minimumSpeedLimit(plan, 0, 500) > 119);
});

test("a tighter circular bend has a lower limit from centripetal acceleration", () => {
  const circle = (radius) => enrichRoute(Array.from({ length: 101 }, (_, i) => point(radius * Math.cos(i / 100 * Math.PI), radius * Math.sin(i / 100 * Math.PI))));
  const small = buildTurnSpeedProfile(circle(20), config);
  const large = buildTurnSpeedProfile(circle(80), config);
  const v20 = speedLimitAt(small, small.at(-1).distanceMeters / 2);
  const v80 = speedLimitAt(large, large.at(-1).distanceMeters / 2);
  assert.ok(v20 > 26 && v20 < 32, v20);
  assert.ok(v80 > v20 * 1.8, [v20, v80]);
});

test("the braking envelope reduces allowed speed before a sharp corner", () => {
  const route = enrichRoute([...Array.from({ length: 61 }, (_, i) => point(i * 5, 0)), ...Array.from({ length: 60 }, (_, i) => point(300, (i + 1) * 5))]);
  const plan = buildTurnSpeedProfile(route, config);
  const before = speedLimitAt(plan, 200);
  const approach = speedLimitAt(plan, 280);
  const corner = speedLimitAt(plan, 300);
  assert.ok(before > approach && approach > corner, [before, approach, corner]);
  assert.ok(corner < 35, corner);
  for (let i = 0; i < plan.length - 1; i++) {
    const delta = plan[i + 1].distanceMeters - plan[i].distanceMeters;
    assert.ok(plan[i].speedSquared <= plan[i + 1].speedSquared + 2 * config.braking_deceleration_mps2 * delta + 1e-8);
  }
});

test("small position jitter on a straight route does not create a sharp turn", () => {
  const route = enrichRoute(Array.from({ length: 101 }, (_, i) => point(i * 5, i % 2 ? 0.5 : -0.5)));
  const plan = buildTurnSpeedProfile(route, config);
  assert.ok(minimumSpeedLimit(plan, 50, 450) > 70);
});

test("duplicate coordinates, a reversal, and the date line keep finite nonzero limits", () => {
  for (const points of [
    [point(0, 0), point(100, 0), point(100, 0), point(0, 0)],
    [{ lat: 0, lng: 179.999, ele: 0 }, { lat: 0, lng: -179.999, ele: 0 }, { lat: 0.001, lng: -179.999, ele: 0 }],
  ]) {
    const plan = buildTurnSpeedProfile(enrichRoute(points), config);
    assert.ok(plan.every((p) => Number.isFinite(p.speedSquared) && p.speedSquared > 0));
  }
  assert.deepEqual(buildTurnSpeedProfile([], config), []);
});
