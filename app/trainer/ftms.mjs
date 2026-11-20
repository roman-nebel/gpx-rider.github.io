// Encodes FTMS road commands and decodes optional features and bike telemetry.
import { clamp } from "../core/geo.mjs";

export function encodeSimulationParameters(gradePercent, config) {
  const bytes = new Uint8Array(7);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x11;
  view.setInt16(1, clamp(Math.round(config.wind_speed_mps * 1000), -32768, 32767), true);
  view.setInt16(3, clamp(Math.round(gradePercent * 100), -32768, 32767), true);
  bytes[5] = clamp(Math.round(config.rolling_resistance_coefficient * 10000), 0, 255);
  bytes[6] = clamp(Math.round(0.5 * config.air_density_kg_per_cubic_meter * config.drag_area_square_meters * 100), 0, 255);
  return bytes;
}

export function decodeFtmsFeatures(data) {
  if (data.byteLength < 8) return null;
  const targets = data.getUint32(4, true);
  return { simulation: Boolean(targets & (1 << 13)), targetPower: Boolean(targets & (1 << 3)), resistance: Boolean(targets & (1 << 2)) };
}

export function decodeResistanceRange(data) {
  if (data.byteLength < 6) return null;
  const range = { min: data.getInt16(0, true), max: data.getInt16(2, true), step: data.getUint16(4, true) };
  return range.max >= range.min && range.step > 0 ? range : null;
}

export function encodeTargetResistance(rawTenths) {
  const bytes = new Uint8Array(3);
  bytes[0] = 0x04;
  new DataView(bytes.buffer).setInt16(1, clamp(Math.round(rawTenths), -32768, 32767), true);
  return bytes;
}

export function decodeIndoorBikeData(data) {
  if (data.byteLength < 2) return null;
  const flags = data.getUint16(0, true);
  let index = 2;
  const telemetry = {
    speedKph: null,
    powerWatts: null,
    cadenceRpm: null,
    totalCaloriesKcal: null,
    heartRateBpm: null,
  };

  // FTMS Indoor Bike Data flag bits, in field order. Bit 0 is "More Data":
  // when it is CLEAR the instantaneous speed field is present.
  if ((flags & 0x0001) === 0 && index + 2 <= data.byteLength) {
    const speed = data.getUint16(index, true);
    if (speed !== 0xffff) telemetry.speedKph = speed / 100;
    index += 2;
  }

  if (flags & 0x0002) index += 2; // average speed

  if ((flags & 0x0004) && index + 2 <= data.byteLength) {
    // Instantaneous cadence: uint16 in units of 0.5 rpm.
    const cadence = data.getUint16(index, true);
    if (cadence !== 0xffff) telemetry.cadenceRpm = cadence / 2;
    index += 2;
  }
  if (flags & 0x0008) index += 2; // average cadence
  if (flags & 0x0010) index += 3; // total distance (uint24)
  if (flags & 0x0020) index += 2; // resistance level

  if ((flags & 0x0040) && index + 2 <= data.byteLength) {
    const power = data.getInt16(index, true);
    if (power !== 0x7fff) telemetry.powerWatts = power;
    index += 2;
  }

  if (flags & 0x0080) index += 2; // average power

  if (flags & 0x0100) {
    // Expended energy: total (uint16 kcal), per hour (uint16), per minute (uint8).
    if (index + 2 <= data.byteLength) {
      const totalKcal = data.getUint16(index, true);
      if (totalKcal !== 0xffff) telemetry.totalCaloriesKcal = totalKcal;
    }
    index += 5;
  }

  if ((flags & 0x0200) && index + 1 <= data.byteLength) {
    const bpm = data.getUint8(index);
    if (bpm > 0) telemetry.heartRateBpm = bpm;
    index += 1;
  }

  return telemetry;
}
