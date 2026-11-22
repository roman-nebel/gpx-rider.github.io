import test from "node:test";
import assert from "node:assert/strict";
import { advanceRoadLoad } from "../app/trainer/load-ramp.mjs";

const config = { coasting_power_watts: 1, trainer_load_ramp_seconds: 1.5 };

test("zero, negative, and missing power unload the trainer immediately", () => {
  for (const power of [0, -10, null, undefined, NaN]) {
    assert.equal(advanceRoadLoad(1, power, 0.1, config), 0);
  }
});

test("positive power restores road load gradually without using flywheel speed", () => {
  let fraction = 0;
  for (let i = 0; i < 3; i++) {
    fraction = advanceRoadLoad(fraction, 200, 0.5, config);
    assert.ok(Math.abs(fraction - (i + 1) / 3) < 1e-9);
  }
  assert.equal(advanceRoadLoad(fraction, 200, 10, config), 1);
});

test("a new coast cancels a partial road-load ramp", () => {
  const fraction = advanceRoadLoad(0, 200, 0.5, config);
  assert.ok(fraction > 0 && fraction < 1);
  assert.equal(advanceRoadLoad(fraction, 0, 0.1, config), 0);
});

test("zero elapsed time does not advance the ramp and a disabled ramp applies full load", () => {
  assert.equal(advanceRoadLoad(0.4, 200, 0, config), 0.4);
  assert.equal(advanceRoadLoad(0.4, 200, 1, { ...config, trainer_load_ramp_seconds: 0 }), 1);
});
