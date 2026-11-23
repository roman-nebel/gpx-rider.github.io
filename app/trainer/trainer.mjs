// FTMS smart-trainer connection over Web Bluetooth: pairing, saved-device
// reconnect, control-point commands, grade (Set Simulation Parameters)
// writes, and Indoor Bike Data telemetry parsing.

import { recordDebugEvent } from "../ride/debug-log.mjs";
import { TrainerRoad } from "./trainer-road.mjs";
import { FtmsControl } from "./ftms-control.mjs";
import { decodeFtmsFeatures, decodeIndoorBikeData, decodeResistanceRange } from "./ftms.mjs";
import { clamp } from "../core/geo.mjs";
import { readJson, writeJson } from "../storage/storage.mjs";
import { GRADE_INTERVAL_MAX_SECONDS, GRADE_INTERVAL_MIN_SECONDS, ROAD_PHYSICS } from "../core/tuning.mjs";
import { connectFec, isFecConnected, resetFec, sendFecGrade, sendFecMinimumResistance, sendFecTargetPower, TACX_FEC_SERVICE } from "./trainer-fec.mjs";

const FTMS_SERVICE = 0x1826;
const FTMS_INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_POWER_RANGE = 0x2ad8;
const FTMS_CONTROL_POINT = 0x2ad9;
const FTMS_STATUS = 0x2ada;
const GATT_RECONNECT_DELAY_MS = 350;

export const OP_REQUEST_CONTROL = 0x00;
export const OP_RESET = 0x01;
export const OP_START_OR_RESUME = 0x07;
export const OP_STOP_OR_PAUSE = 0x08;
export const OP_SET_SIMULATION = 0x11;

const OP_SET_TARGET_POWER = 0x05;

const FTMS_OPCODE_NAMES = {
  [OP_REQUEST_CONTROL]: "Request Control",
  [OP_RESET]: "Reset",
  [OP_START_OR_RESUME]: "Start/Resume",
  [OP_STOP_OR_PAUSE]: "Stop/Pause",
  [OP_SET_TARGET_POWER]: "Set Target Power",
  [OP_SET_SIMULATION]: "Set Simulation",
};

const TRAINER_STORAGE_KEY = "gpx-rider:last-trainer";

const trainer = {
  device: null,
  ready: false, // Hardware writes start only after the control handshake.
  protocol: null, // "ftms" | "fec" — which backend owns the connected device
  controlPoint: null,
  powerRange: null,
  features: null,
  roadResult: null,
  road: new TrainerRoad(ROAD_PHYSICS),
  resistanceRange: null,
  powerSession: null,
  control: null,
  bikeData: null,
  gradeSampleSum: 0,
  gradeSampleCount: 0,
  lastGradeAttemptAt: 0,
};

let callbacks = {
  onTelemetry: () => {},
  onStatus: () => {},
  onMessage: () => {},
  onPowerRejected: () => {},
};

export function initTrainer(handlers) {
  callbacks = { ...callbacks, ...handlers };
}

export function trainerDisplayName() {
  return trainer.device?.name || "Connected";
}

export function isTrainerConnected() {
  return Boolean(trainer.controlPoint) || isFecConnected();
}

export async function connectTrainer() {
  if (!navigator.bluetooth) {
    callbacks.onStatus("Use Chrome");
    callbacks.onMessage("Web Bluetooth is available in Chrome or Edge, not Safari.");
    return;
  }

  try {
    callbacks.onStatus("Pairing");
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [FTMS_SERVICE] },
        { services: [TACX_FEC_SERVICE] },
        { namePrefix: "KICKR" },
        { namePrefix: "Tacx" },
      ],
      optionalServices: [FTMS_SERVICE, TACX_FEC_SERVICE],
    });

    await connectTrainerDevice(device);
  } catch (error) {
    console.error(error);
    recordDebugEvent("trainer.connection-failed", { error });
    callbacks.onStatus("Failed");
    callbacks.onMessage(connectionErrorMessage(error, "trainer"));
  }
}

export async function reconnectSavedTrainer() {
  const savedTrainer = readJson(TRAINER_STORAGE_KEY);
  if (!savedTrainer || !navigator.bluetooth?.getDevices) return;

  try {
    callbacks.onStatus("Reconnecting");
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((candidate) => (
      candidate.id === savedTrainer.id ||
      candidate.name === savedTrainer.name ||
      candidate.name?.startsWith("KICKR")
    ));

    if (!device) {
      callbacks.onStatus(savedTrainer.name || "Saved");
      return;
    }

    await connectTrainerDevice(device);
  } catch (error) {
    recordDebugEvent("trainer.reconnect-failed", { error });
    console.warn("Could not reconnect saved trainer.", error);
    callbacks.onStatus(savedTrainer.name || "Saved");
  }
}

async function connectTrainerDevice(device) {
  resetTrainerConnection();
  device.addEventListener("gattserverdisconnected", handleTrainerDisconnected);

  // FTMS first (KICKR and other standards-compliant trainers); fall back to
  // Tacx FE-C for the wheel-on Tacx units that never got FTMS firmware. The
  // paired device exposes exactly one of the two control protocols.
  const ftmsService = await getPrimaryServiceWithRetry(device, FTMS_SERVICE, "trainer", { optional: true });
  if (ftmsService) {
    await connectFtms(ftmsService);
    trainer.protocol = "ftms";
  } else {
    const fecService = await getPrimaryServiceWithRetry(device, TACX_FEC_SERVICE, "trainer", { optional: true });
    if (!fecService) {
      throw new Error("This trainer exposes neither FTMS nor Tacx FE-C over Bluetooth.");
    }
    await connectFec(fecService, {
      onTelemetry: callbacks.onTelemetry,
      onStatus: callbacks.onStatus,
      displayName: device.name || "Tacx",
    });
    trainer.protocol = "fec";
  }

  trainer.device = device;
  writeJson(TRAINER_STORAGE_KEY, {
    id: device.id,
    name: device.name || (trainer.protocol === "fec" ? "Tacx" : "KICKR"),
    savedAt: new Date().toISOString(),
  });

  if (trainer.protocol === "ftms") {
    try {
      await sendTrainerCommand(OP_REQUEST_CONTROL, [], { throwOnError: true });
      // Clear a power target left by another app before enabling road mode.
      await sendTrainerCommand(OP_RESET, [], { throwOnError: true });
    } catch (error) {
      resetTrainerConnection();
      throw error;
    }
  }
  // FE-C trainers accept Track Resistance directly — no control handshake.

  trainer.ready = true;
  trainer.road.attach({
    kind: trainer.protocol,
    simulation: trainer.features?.simulation,
    minimumResistance: trainer.features?.resistance ? trainer.resistanceRange?.min ?? null : null,
    isErg: () => Boolean(trainer.powerSession),
    send: (bytes, valid) => trainer.control.send(bytes, valid),
    sendFec: (grade, config, minimum, allowWrite, allowContinue) => minimum ? sendFecMinimumResistance(allowWrite)
      : sendFecGrade(grade, { config, allowWrite, allowContinue }),
    onApplied: clearTrainerErrorStatus,
    onError: () => callbacks.onStatus("BLE error"),
  });
  recordDebugEvent("trainer.connected", { name: device.name, protocol: trainer.protocol, features: trainer.features, controlResponsesAvailable: trainer.control?.receivesResponses ?? false, powerRange: trainer.powerRange, resistanceRange: trainer.resistanceRange });
  callbacks.onStatus(device.name || "Connected");
}

async function connectFtms(service) {
  try {
    const feature = await service.getCharacteristic(0x2acc);
    const featureData = await feature.readValue();
    recordDebugEvent("trainer.ftms.features", { bytes: featureData });
    trainer.features = decodeFtmsFeatures(featureData);
    console.debug("[trainer] FTMS features", trainer.features);
  } catch {
    console.debug("[trainer] FTMS features unavailable; support is unverified.");
  }
  if (trainer.features?.resistance) {
    try {
      const range = await service.getCharacteristic(0x2ad6);
      trainer.resistanceRange = decodeResistanceRange(await range.readValue());
    } catch {
      // Without an advertised minimum, use zero simulation load instead.
    }
  }
  trainer.controlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT);
  trainer.control = new FtmsControl(trainer.controlPoint, (opcode, result, text) => {
    if (opcode === OP_SET_SIMULATION || opcode === 4) trainer.roadResult = result === 1 ? "Last road command accepted." : `Road command rejected: ${text}.`;
    if (result !== 1 && opcode !== OP_SET_SIMULATION && opcode !== 4) callbacks.onStatus(text);
  });
  const receivesResponses = await trainer.control.subscribe();
  await subscribeToBikeData(service);
  try {
    const characteristic = await service.getCharacteristic(FTMS_POWER_RANGE);
    const range = await characteristic.readValue();
    const min = Math.max(0, range.getInt16(0, true));
    const max = range.getInt16(2, true);
    const step = range.getUint16(4, true) || 1;
    if (receivesResponses && trainer.features?.targetPower !== false && max >= min) trainer.powerRange = { min, max, step };
  } catch {
    // Target power is optional. The route can still drive simulation grade.
  }

  try {
    const status = await service.getCharacteristic(FTMS_STATUS);
    status.addEventListener("characteristicvaluechanged", event => recordDebugEvent("trainer.ftms.status", { bytes: event.target.value }));
    await status.startNotifications();
  } catch {
    // Some trainers expose indications only on the control point.
  }
}

function resetTrainerConnection() {
  trainer.ready = false;
  trainer.device = null;
  trainer.protocol = null;
  trainer.control?.reset();
  trainer.control = null;
  trainer.controlPoint = null;
  trainer.powerRange = null;
  trainer.features = null;
  trainer.roadResult = null;
  trainer.resistanceRange = null;
  trainer.road.detach();
  trainer.powerSession = null;
  trainer.bikeData = null;
  resetFec();
}

function handleTrainerDisconnected() {
  recordDebugEvent("trainer.disconnected", { protocol: trainer.protocol });
  resetTrainerConnection();
  callbacks.onTelemetry(null);
  callbacks.onStatus("Disconnected");
}

async function getPrimaryServiceWithRetry(device, serviceUuid, label, { optional = false } = {}) {
  try {
    const server = await connectGatt(device);
    return await server.getPrimaryService(serviceUuid);
  } catch (error) {
    // An absent optional service is a normal detection outcome, not a failure.
    if (optional && isServiceNotFoundError(error)) return null;
    if (!isGattDisconnectedError(error)) throw error;

    console.warn(`GATT disconnected while discovering ${label}; reconnecting once.`, error);
    callbacks.onStatus("Reconnecting");
    try {
      device.gatt?.disconnect?.();
    } catch {
      // Some browsers throw if already disconnected; connecting below is enough.
    }
    await delay(GATT_RECONNECT_DELAY_MS);
    try {
      const server = await connectGatt(device);
      return await server.getPrimaryService(serviceUuid);
    } catch (retryError) {
      if (optional && isServiceNotFoundError(retryError)) return null;
      throw retryError;
    }
  }
}

function isServiceNotFoundError(error) {
  return error?.name === "NotFoundError" || /No Services matching|not found/i.test(error?.message || "");
}

async function connectGatt(device) {
  if (!device.gatt) throw new Error("This Bluetooth device does not expose a GATT server.");
  if (device.gatt.connected) return device.gatt;
  return device.gatt.connect();
}

function isGattDisconnectedError(error) {
  return /GATT Server is disconnected|Cannot retrieve services|disconnected/i.test(error?.message || "");
}

function connectionErrorMessage(error, label) {
  if (isGattDisconnectedError(error)) {
    return `Could not keep the ${label} connected. Turn it awake, keep it nearby, then connect again.`;
  }
  return error?.message || `Could not connect to the ${label}.`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function subscribeToBikeData(service) {
  try {
    trainer.bikeData = await service.getCharacteristic(FTMS_INDOOR_BIKE_DATA);
    trainer.bikeData.addEventListener("characteristicvaluechanged", handleBikeData);
    await trainer.bikeData.startNotifications();
  } catch (error) {
    console.warn("Indoor Bike Data notifications are not available.", error);
  }
}

function handleBikeData(event) {
  if (event.target !== trainer.bikeData) return;
  recordDebugEvent("trainer.ftms.bike-data", { bytes: event.target.value });
  const telemetry = decodeIndoorBikeData(event.target.value);
  if (telemetry) callbacks.onTelemetry(telemetry);
}

// Averages every grade sample seen since the last send instead of firing the
// instantaneous value: smooths out point-to-point jitter (2.9/3.0/2.9) and,
// combined with the hard interval, guarantees we never enqueue BLE writes
// faster than the trainer can actually process them.
export function queueTrainerGradeSample(gradePercent, { force = false, intervalSeconds = 2 } = {}) {
  if (trainer.powerSession) return;
  trainer.gradeSampleSum += gradePercent;
  trainer.gradeSampleCount += 1;

  const now = performance.now();
  const intervalMs = clamp(intervalSeconds, GRADE_INTERVAL_MIN_SECONDS, GRADE_INTERVAL_MAX_SECONDS) * 1000;
  const dueForSend = force || trainer.lastGradeAttemptAt === 0 || now - trainer.lastGradeAttemptAt >= intervalMs;
  if (!dueForSend) return;

  const averageGrade = trainer.gradeSampleSum / trainer.gradeSampleCount;
  trainer.gradeSampleSum = 0;
  trainer.gradeSampleCount = 0;
  trainer.lastGradeAttemptAt = now;

  void sendTrainerGrade(averageGrade);
}

export function sendTrainerGrade(gradePercent, options = {}) {
  if (!trainer.ready) return Promise.resolve(false);
  return trainer.road.sendGrade(gradePercent, options);
}

export function setTrainerRoadLoad(fraction, brakeStrength, grade, uphillGradePercent = 0) {
  return trainer.road.setLoad(fraction, brakeStrength, grade, uphillGradePercent);
}

export function trainerSupportsTargetPower() {
  return trainer.ready && (trainer.protocol === "fec" ? isFecConnected() : Boolean(trainer.protocol === "ftms" && trainer.powerRange));
}

export function queueTrainerTargetPower(targetWatts) {
  if (!trainerSupportsTargetPower() || !Number.isFinite(targetWatts)) return null;
  const range = trainer.powerRange ?? { min: 0, max: 1000, step: 0.25 };
  const steps = Math.floor((range.max - range.min) / range.step);
  const watts = range.min + clamp(Math.round((targetWatts - range.min) / range.step), 0, steps) * range.step;
  const session = trainer.powerSession ??= { inFlight: false, watts: null };
  if (session.inFlight) return session.watts ?? watts;
  if (watts === session.watts) return watts;

  session.inFlight = true;
  trainer.road.invalidate();
  const write = trainer.protocol === "fec" ? sendFecTargetPower(watts, () => trainer.powerSession === session) :
    sendBytes([OP_SET_TARGET_POWER, watts & 0xff, watts >> 8], session);
  write.then(() => {
    session.watts = watts;
  }, (error) => {
    if (trainer.powerSession === session) callbacks.onPowerRejected(error.message);
  }).finally(() => {
    session.inFlight = false;
  });
  return watts;
}

export function releaseTrainerTargetPower(grade) {
  if (!trainer.powerSession) return;
  trainer.powerSession = null;
  trainer.gradeSampleSum = 0;
  trainer.gradeSampleCount = 0;
  trainer.lastGradeAttemptAt = performance.now();
  void sendTrainerGrade(grade, { force: true });
}

export async function sendTrainerCommand(opcode, payload = [], { throwOnError = false } = {}) {
  if (!trainer.controlPoint) return;
  const opcodeName = FTMS_OPCODE_NAMES[opcode] || `0x${opcode.toString(16)}`;
  console.debug(`[trainer] sending command ${opcodeName}`);
  try {
    await sendBytes([opcode, ...payload]);
    clearTrainerErrorStatus();
    console.debug(`[trainer] command ${opcodeName} acknowledged`);
  } catch (error) {
    console.error(`[trainer] command ${opcodeName} failed`, error);
    callbacks.onStatus("BLE error");
    if (throwOnError) throw error;
  }
}

function clearTrainerErrorStatus() {
  callbacks.onStatus(trainerDisplayName(), { onlyClearError: true });
}

function sendBytes(bytes, powerSession = null) {
  return trainer.control.send(bytes, () => powerSession
    ? trainer.powerSession === powerSession
    : bytes[0] !== OP_SET_SIMULATION || !trainer.powerSession);
}

export function configureTrainerRoad(config) {
  trainer.road.configure(config);
}

export function trainerRoadSupport() {
  if (!isTrainerConnected()) return "Connect a trainer to check road control. Mass is always used for app calculations.";
  if (trainer.protocol === "fec") return "FE-C: grade, rolling resistance, wind, and mass are sent. Device acceptance is unverified.";
  if (trainer.features?.simulation === false) return "This trainer does not advertise road simulation support.";
  return `${trainer.roadResult ?? "Road command acceptance not yet verified."} ${trainer.control?.receivesResponses ? "" : "Device acceptance cannot be verified. "}${trainer.features?.simulation ? "FTMS road simulation supported." : "FTMS road simulation support is unverified."} Mass cannot be set through FTMS simulation; configure it in the manufacturer's app.`;
}
