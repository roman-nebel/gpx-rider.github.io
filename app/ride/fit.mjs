// Encodes Garmin FIT virtual-ride activities with optional workout steps and linked laps.
//
// samples: [{ t (unix seconds), lat, lng, ele (m), distance (m),
//             speedKph, powerWatts, heartRateBpm, cadenceRpm }] — nullable
//             fields allowed.
// summary: { startTimeMs, endTimeMs (optional), totalElapsedSeconds, totalTimerSeconds,
//            totalDistanceMeters, totalCalories (kcal, nullable) }

import { APP_NAME } from "../core/tuning.mjs";

const FIT_EPOCH_OFFSET_SECONDS = 631065600; // 1989-12-31T00:00:00Z
const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

const BASE_TYPE = {
  enum: 0x00,
  string: 0x07,
  uint8: 0x02,
  uint16: 0x84,
  uint32: 0x86,
  sint32: 0x85,
};

const INVALID = {
  [BASE_TYPE.enum]: 0xff,
  [BASE_TYPE.string]: 0x00,
  [BASE_TYPE.uint8]: 0xff,
  [BASE_TYPE.uint16]: 0xffff,
  [BASE_TYPE.uint32]: 0xffffffff,
  [BASE_TYPE.sint32]: 0x7fffffff,
};

const SIZE = {
  [BASE_TYPE.enum]: 1,
  [BASE_TYPE.string]: 1,
  [BASE_TYPE.uint8]: 1,
  [BASE_TYPE.uint16]: 2,
  [BASE_TYPE.uint32]: 4,
  [BASE_TYPE.sint32]: 4,
};

const GLOBAL_MSG = { fileId: 0, session: 18, lap: 19, record: 20, event: 21, workout: 26, workoutStep: 27, activity: 34 };
const FILE_TYPE_ACTIVITY = 4;
const SPORT_CYCLING = 2;
const SUB_SPORT_VIRTUAL_ACTIVITY = 58;
const EVENT_TIMER = 0;
const EVENT_LAP = 9;
const EVENT_SESSION = 8;
const EVENT_ACTIVITY = 26;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const EVENT_TYPE_STOP_ALL = 4;
const ACTIVITY_TYPE_MANUAL = 0;
const WORKOUT_TARGET_OPEN = 2;
const WORKOUT_TARGET_CADENCE = 3;
const WORKOUT_TARGET_POWER = 4;

// Message schemas: [fieldNumber, baseType]
const FILE_ID_FIELDS = [
  [0, BASE_TYPE.enum], // type
  [1, BASE_TYPE.uint16], // manufacturer
  [2, BASE_TYPE.uint16], // product
  [4, BASE_TYPE.uint32], // time_created
  [8, BASE_TYPE.string, 16], // product_name
];
const EVENT_FIELDS = [
  [253, BASE_TYPE.uint32], // timestamp
  [0, BASE_TYPE.enum], // event
  [1, BASE_TYPE.enum], // event_type
];
const RECORD_FIELDS = [
  [253, BASE_TYPE.uint32], // timestamp
  [0, BASE_TYPE.sint32], // position_lat (semicircles)
  [1, BASE_TYPE.sint32], // position_long (semicircles)
  [2, BASE_TYPE.uint16], // altitude (scale 5, offset 500)
  [5, BASE_TYPE.uint32], // distance (scale 100)
  [6, BASE_TYPE.uint16], // speed (m/s, scale 1000)
  [7, BASE_TYPE.uint16], // power (W)
  [3, BASE_TYPE.uint8], // heart_rate (bpm)
  [4, BASE_TYPE.uint8], // cadence (rpm)
];
const LAP_FIELDS = [
  [253, BASE_TYPE.uint32], // timestamp (lap end)
  [2, BASE_TYPE.uint32], // start_time
  [7, BASE_TYPE.uint32], // total_elapsed_time (scale 1000)
  [8, BASE_TYPE.uint32], // total_timer_time (scale 1000)
  [9, BASE_TYPE.uint32], // total_distance (scale 100)
  [11, BASE_TYPE.uint16], // total_calories (kcal)
  [0, BASE_TYPE.enum], // event
  [1, BASE_TYPE.enum], // event_type
  [25, BASE_TYPE.enum], // sport
];
const WORKOUT_LAP_FIELDS = [
  ...LAP_FIELDS,
  [254, BASE_TYPE.uint16], // message_index
  [71, BASE_TYPE.uint16], // wkt_step_index
];
const WORKOUT_FIELDS = [
  [4, BASE_TYPE.enum], [6, BASE_TYPE.uint16], [8, BASE_TYPE.string, 128],
];
const WORKOUT_STEP_FIELDS = [
  [254, BASE_TYPE.uint16], // message_index
  [0, BASE_TYPE.string, 128], // wkt_step_name
  [1, BASE_TYPE.enum], [2, BASE_TYPE.uint32], // duration
  [3, BASE_TYPE.enum], [4, BASE_TYPE.uint32], // target
  [5, BASE_TYPE.uint32], [6, BASE_TYPE.uint32], // custom target bounds
  [7, BASE_TYPE.enum], [8, BASE_TYPE.string, 255], // intensity and notes
  [9, BASE_TYPE.enum], [10, BASE_TYPE.uint16], [11, BASE_TYPE.uint16], // equipment and exercise
  [12, BASE_TYPE.uint16], [13, BASE_TYPE.uint16], // exercise weight and display unit
  [19, BASE_TYPE.enum], [20, BASE_TYPE.uint32], // secondary target
  [21, BASE_TYPE.uint32], [22, BASE_TYPE.uint32], // secondary custom target bounds
];
const SESSION_FIELDS = [
  [253, BASE_TYPE.uint32], // timestamp (session end)
  [2, BASE_TYPE.uint32], // start_time
  [7, BASE_TYPE.uint32], // total_elapsed_time (scale 1000)
  [8, BASE_TYPE.uint32], // total_timer_time (scale 1000)
  [9, BASE_TYPE.uint32], // total_distance (scale 100)
  [11, BASE_TYPE.uint16], // total_calories (kcal)
  [5, BASE_TYPE.enum], // sport
  [6, BASE_TYPE.enum], // sub_sport
  [25, BASE_TYPE.uint16], // first_lap_index
  [26, BASE_TYPE.uint16], // num_laps
  [0, BASE_TYPE.enum], // event
  [1, BASE_TYPE.enum], // event_type
];
const ACTIVITY_FIELDS = [
  [253, BASE_TYPE.uint32], // timestamp
  [0, BASE_TYPE.uint32], // total_timer_time (scale 1000)
  [1, BASE_TYPE.uint16], // num_sessions
  [2, BASE_TYPE.enum], // type
  [3, BASE_TYPE.enum], // event
  [4, BASE_TYPE.enum], // event_type
  [5, BASE_TYPE.uint32], // local_timestamp
];

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function fitCrc16(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0x0f];
    tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
  }
  return crc & 0xffff;
}

export function toFitTimestamp(unixSeconds) {
  return Math.max(0, Math.round(unixSeconds) - FIT_EPOCH_OFFSET_SECONDS);
}

// FIT's activity.local_timestamp is the UTC timestamp shifted by the
// device's local UTC offset — consumers (Garmin Connect, Strava) read the
// difference between it and the UTC timestamp to display the ride at the
// rider's actual local time instead of UTC.
function toFitLocalTimestamp(fitTimestamp, unixMs) {
  const offsetSeconds = -new Date(unixMs).getTimezoneOffset() * 60;
  return fitTimestamp + offsetSeconds;
}

export function degreesToSemicircles(degrees) {
  return Math.round(degrees * SEMICIRCLES_PER_DEGREE);
}

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
  }

  u16(value) {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  u32(value) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  write(baseType, value, size = SIZE[baseType]) {
    if (baseType === BASE_TYPE.string) {
      const text = typeof value === "string" ? value : "";
      const encoded = new Uint8Array(size);
      new TextEncoder().encodeInto(text, encoded.subarray(0, -1));
      this.bytes.push(...encoded);
      return;
    }
    const encoded = value === null || value === undefined || Number.isNaN(value)
      ? INVALID[baseType]
      : value;
    if (SIZE[baseType] === 1) this.u8(encoded);
    else if (SIZE[baseType] === 2) this.u16(encoded);
    else this.u32(encoded);
  }
}

function writeDefinition(writer, localType, globalMsg, fields) {
  writer.u8(0x40 | localType); // definition record header
  writer.u8(0); // reserved
  writer.u8(0); // little-endian
  writer.u16(globalMsg);
  writer.u8(fields.length);
  for (const [fieldNumber, baseType, size = SIZE[baseType]] of fields) {
    writer.u8(fieldNumber);
    writer.u8(size);
    writer.u8(baseType);
  }
}

function writeData(writer, localType, fields, values) {
  writer.u8(localType);
  fields.forEach(([, baseType, size], index) => writer.write(baseType, values[index], size));
}

function encodeScaled(value, scale, offset = 0) {
  if (!Number.isFinite(value)) return null;
  return Math.round((value + offset) * scale);
}

function fitWorkoutStep(step) {
  if (step.durationSeconds === undefined) return step;
  const power = step.power;
  const cadence = step.cadenceRpm > 0 ? Math.round(step.cadenceRpm) : null;
  const ramp = power?.length === 2 && power[0] !== power[1];
  const percent = (fraction) => `${Number((fraction * 100).toFixed(10))}% FTP`;
  return {
    0: step.name, 1: 0, 2: encodeScaled(step.durationSeconds, 1000),
    3: power ? WORKOUT_TARGET_POWER : cadence ? WORKOUT_TARGET_CADENCE : WORKOUT_TARGET_OPEN,
    4: power || cadence ? 0 : null,
    5: power ? encodeScaled(Math.min(...power), 100) : cadence,
    6: power ? encodeScaled(Math.max(...power), 100) : cadence,
    8: ramp ? `Power ramp: ${percent(power[0])} to ${percent(power[1])}` : null,
    19: power && cadence ? WORKOUT_TARGET_CADENCE : null,
    20: power && cadence ? 0 : null,
    21: power ? cadence : null,
    22: power ? cadence : null,
  };
}

function writeWorkout(writer, workout) {
  writeDefinition(writer, 6, GLOBAL_MSG.workout, WORKOUT_FIELDS);
  writeData(writer, 6, WORKOUT_FIELDS, [SPORT_CYCLING, workout.steps.length, workout.name]);
  writeDefinition(writer, 7, GLOBAL_MSG.workoutStep, WORKOUT_STEP_FIELDS);
  workout.steps.forEach((step, index) => {
    const fields = fitWorkoutStep(step);
    writeData(writer, 7, WORKOUT_STEP_FIELDS, WORKOUT_STEP_FIELDS.map(([number]) =>
      number === 254 ? index : fields[number]));
  });
}

function writeWorkoutLaps(writer, boundaries, summary, endTime) {
  const start = { startMs: summary.startTimeMs, timerSeconds: 0, distanceMeters: 0, caloriesKcal: 0 };
  const end = {
    startMs: endTime * 1000, timerSeconds: summary.totalTimerSeconds,
    distanceMeters: summary.totalDistanceMeters, caloriesKcal: summary.totalCalories,
  };
  const starts = [start, ...boundaries];
  writeDefinition(writer, 3, GLOBAL_MSG.lap, WORKOUT_LAP_FIELDS);
  let count = 0;
  starts.forEach((from, index) => {
    const to = starts[index + 1] ?? end;
    const timer = Math.max(0, to.timerSeconds - from.timerSeconds);
    if (!timer) return;
    const startTime = toFitTimestamp(from.startMs / 1000);
    const lapEnd = Math.max(startTime, toFitTimestamp(to.startMs / 1000));
    const elapsed = Math.max(timer, (to.startMs - from.startMs) / 1000);
    const calories = Number.isFinite(to.caloriesKcal) && Number.isFinite(from.caloriesKcal)
      ? Math.max(0, Math.round(to.caloriesKcal) - Math.round(from.caloriesKcal)) : null;
    writeData(writer, 3, WORKOUT_LAP_FIELDS, [
      lapEnd, startTime, encodeScaled(elapsed, 1000), encodeScaled(timer, 1000),
      encodeScaled(Math.max(0, to.distanceMeters - from.distanceMeters), 100), calories,
      EVENT_LAP, EVENT_TYPE_STOP, SPORT_CYCLING, count++, from.stepIndex,
    ]);
  });
  return count;
}

export function encodeFitActivity({ samples, summary, workout, workoutLaps = [] }) {
  if (!samples?.length) throw new Error("No ride samples to encode.");

  const startFit = toFitTimestamp(summary.startTimeMs / 1000);
  const endTimeMs = summary.endTimeMs ?? samples.at(-1).t * 1000;
  const endFit = toFitTimestamp(endTimeMs / 1000);
  const writer = new ByteWriter();

  writeDefinition(writer, 0, GLOBAL_MSG.fileId, FILE_ID_FIELDS);
  writeData(writer, 0, FILE_ID_FIELDS, [FILE_TYPE_ACTIVITY, null, null, startFit, APP_NAME]);
  if (workout?.steps?.length) writeWorkout(writer, workout);

  writeDefinition(writer, 1, GLOBAL_MSG.event, EVENT_FIELDS);
  writeData(writer, 1, EVENT_FIELDS, [startFit, EVENT_TIMER, EVENT_TYPE_START]);

  writeDefinition(writer, 2, GLOBAL_MSG.record, RECORD_FIELDS);
  for (const sample of samples) {
    writeData(writer, 2, RECORD_FIELDS, [
      toFitTimestamp(sample.t),
      Number.isFinite(sample.lat) ? degreesToSemicircles(sample.lat) : null,
      Number.isFinite(sample.lng) ? degreesToSemicircles(sample.lng) : null,
      encodeScaled(sample.ele, 5, 500),
      encodeScaled(sample.distance, 100),
      encodeScaled(Number.isFinite(sample.speedKph) ? sample.speedKph / 3.6 : NaN, 1000),
      Number.isFinite(sample.powerWatts) ? Math.max(0, Math.round(sample.powerWatts)) : null,
      Number.isFinite(sample.heartRateBpm) ? Math.round(sample.heartRateBpm) : null,
      Number.isFinite(sample.cadenceRpm) ? Math.round(sample.cadenceRpm) : null,
    ]);
  }

  writeData(writer, 1, EVENT_FIELDS, [endFit, EVENT_TIMER, EVENT_TYPE_STOP_ALL]);

  const elapsedMs = encodeScaled(summary.totalElapsedSeconds, 1000);
  const timerMs = encodeScaled(summary.totalTimerSeconds, 1000);
  const distanceCm = encodeScaled(summary.totalDistanceMeters, 100);
  const calories = Number.isFinite(summary.totalCalories) ? Math.round(summary.totalCalories) : null;

  const lapCount = workout?.steps?.length && workoutLaps.length
    ? writeWorkoutLaps(writer, workoutLaps, summary, endTimeMs / 1000) : 0;
  if (!lapCount) {
    writeDefinition(writer, 3, GLOBAL_MSG.lap, LAP_FIELDS);
    writeData(writer, 3, LAP_FIELDS, [
      endFit, startFit, elapsedMs, timerMs, distanceCm, calories,
      EVENT_LAP, EVENT_TYPE_STOP, SPORT_CYCLING,
    ]);
  }

  writeDefinition(writer, 4, GLOBAL_MSG.session, SESSION_FIELDS);
  writeData(writer, 4, SESSION_FIELDS, [
    endFit, startFit, elapsedMs, timerMs, distanceCm, calories,
    SPORT_CYCLING, SUB_SPORT_VIRTUAL_ACTIVITY, 0, lapCount || 1,
    EVENT_SESSION, EVENT_TYPE_STOP,
  ]);

  writeDefinition(writer, 5, GLOBAL_MSG.activity, ACTIVITY_FIELDS);
  writeData(writer, 5, ACTIVITY_FIELDS, [
    endFit, timerMs, 1, ACTIVITY_TYPE_MANUAL, EVENT_ACTIVITY, EVENT_TYPE_STOP,
    toFitLocalTimestamp(endFit, endTimeMs),
  ]);

  const dataBytes = writer.bytes;

  const header = new ByteWriter();
  header.u8(14); // header size
  header.u8(0x10); // protocol version 1.0
  header.u16(2132); // profile version 21.32
  header.u32(dataBytes.length);
  header.u8(".".charCodeAt(0));
  header.u8("F".charCodeAt(0));
  header.u8("I".charCodeAt(0));
  header.u8("T".charCodeAt(0));
  header.u16(fitCrc16(header.bytes));

  const fileBytes = [...header.bytes, ...dataBytes];
  const fileCrc = fitCrc16(fileBytes);
  fileBytes.push(fileCrc & 0xff, (fileCrc >> 8) & 0xff);

  return new Uint8Array(fileBytes);
}
