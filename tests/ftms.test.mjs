import test from "node:test";
import assert from "node:assert/strict";
import { encodeSimulationParameters, decodeFtmsFeatures, decodeIndoorBikeData, decodeResistanceRange, encodeTargetResistance } from "../app/trainer/ftms.mjs";
import { ROAD_PHYSICS } from "../app/core/tuning.mjs";

test("FTMS road command encodes grade, rolling resistance, and aerodynamic coefficient once", () => {
  // Cw = rho * CdA / 2 = 0.294 kg/m, quantized to 0.29 in FTMS.
  assert.deepEqual([...encodeSimulationParameters(5, ROAD_PHYSICS)], [0x11, 0, 0, 0xf4, 1, 50, 29]);
  const downhill = encodeSimulationParameters(-5, { ...ROAD_PHYSICS, wind_speed_mps: -2 });
  const view = new DataView(downhill.buffer);
  assert.equal(view.getInt16(1, true), -2000);
  assert.equal(view.getInt16(3, true), -500);
});

test("FTMS capabilities distinguish optional simulation and ERG support", () => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setUint32(4, (1 << 13) | (1 << 3), true);
  assert.deepEqual(decodeFtmsFeatures(new DataView(bytes.buffer)), { simulation: true, targetPower: true, resistance: false });
  assert.equal(decodeFtmsFeatures(new DataView(new ArrayBuffer(3))), null);
});

test("minimum FTMS resistance uses the advertised range and signed protocol units", () => {
  const data = new DataView(Uint8Array.of(20, 0, 0xe8, 3, 10, 0).buffer);
  assert.deepEqual(decodeResistanceRange(data), { min: 20, max: 1000, step: 10 });
  assert.deepEqual([...encodeTargetResistance(decodeResistanceRange(data).min)], [4, 20, 0]);
  assert.deepEqual([...encodeTargetResistance(-10)], [4, 246, 255]);
  assert.equal(decodeResistanceRange(new DataView(new ArrayBuffer(2))), null);
  assert.equal(decodeResistanceRange(new DataView(Uint8Array.of(100, 0, 10, 0, 1, 0).buffer)), null);
});

test("split FTMS data preserves missing fields, zero effort, and unknown cadence", () => {
  const speed = decodeIndoorBikeData(new DataView(Uint8Array.of(0, 0, 0xb8, 0x0b).buffer));
  assert.equal(speed.speedKph, 30);
  assert.equal(speed.powerWatts, null);
  const stopped = decodeIndoorBikeData(new DataView(Uint8Array.of(0x45, 0, 0, 0, 0, 0).buffer));
  assert.equal(stopped.speedKph, null);
  assert.equal(stopped.cadenceRpm, 0);
  assert.equal(stopped.powerWatts, 0);
  const unknown = decodeIndoorBikeData(new DataView(Uint8Array.of(5, 0, 255, 255).buffer));
  assert.equal(unknown.cadenceRpm, null);
  assert.equal(decodeIndoorBikeData(new DataView(new ArrayBuffer(1))), null);
});
