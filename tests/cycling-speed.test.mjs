import assert from "node:assert/strict";
import test from "node:test";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";
import { cyclingSpeedForPower } from "../app/ride/cycling-speed.mjs";

test("road speed responds to actual power and the route grade", () => {
  const climb = cyclingSpeedForPower(100, 10, ROAD_PHYSICS);
  const flat = cyclingSpeedForPower(100, 0, ROAD_PHYSICS);
  assert.ok(climb >= 3 && climb <= 4, `expected 3–4 km/h, got ${climb}`);
  assert.ok(flat > climb);
  assert.ok(cyclingSpeedForPower(200, 10, ROAD_PHYSICS) > climb);
});

test("zero power stalls uphill and can coast downhill within the configured solver bound", () => {
  assert.equal(cyclingSpeedForPower(0, 10, ROAD_PHYSICS), 0);
  const downhill = cyclingSpeedForPower(0, -10, ROAD_PHYSICS);
  assert.ok(downhill > 0 && downhill <= ROAD_PHYSICS.max_speed_kph);
});


test("an uncapped ERG speed solver finds its finite drag equilibrium above the free-ride ceiling", () => {
  const config = { ...ROAD_PHYSICS, max_speed_kph: Infinity };
  const speed = cyclingSpeedForPower(5000, 0, config);
  assert.ok(Number.isFinite(speed) && speed > 72, String(speed));
});
