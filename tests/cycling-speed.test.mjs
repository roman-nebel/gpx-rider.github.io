import assert from "node:assert/strict";
import test from "node:test";
import { ERG_ROAD_SPEED } from "../app/core/tuning.mjs";
import { cyclingSpeedForPower } from "../app/ride/cycling-speed.mjs";

test("road speed responds to actual power and the route grade", () => {
  const climb = cyclingSpeedForPower(100, 10, ERG_ROAD_SPEED);
  const flat = cyclingSpeedForPower(100, 0, ERG_ROAD_SPEED);
  assert.ok(climb >= 3 && climb <= 4, `expected 3–4 km/h, got ${climb}`);
  assert.ok(flat > climb);
  assert.ok(cyclingSpeedForPower(200, 10, ERG_ROAD_SPEED) > climb);
});

test("zero power stalls uphill and can coast downhill within the speed limit", () => {
  assert.equal(cyclingSpeedForPower(0, 10, ERG_ROAD_SPEED), 0);
  const downhill = cyclingSpeedForPower(0, -10, ERG_ROAD_SPEED);
  assert.ok(downhill > 0 && downhill <= ERG_ROAD_SPEED.max_speed_kph);
});
