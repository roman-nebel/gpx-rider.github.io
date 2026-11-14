// Decodes the Garmin FIT Workout messages needed to import a cycling plan.
import { fitCrc16 } from "../ride/fit.mjs";

const FILE_ID = 0;
const WORKOUT = 26;
const WORKOUT_STEP = 27;
const WORKOUT_FILE = 5;
const CYCLING = 2;
const REPEAT_TYPES = new Set([6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 27]);
const INVALID_FILE = "The file is not a valid FIT file or is damaged.";

export function decodeFitWorkout(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const headerSize = bytes[0];
  if (bytes.length < 14 || (headerSize !== 12 && headerSize !== 14) ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== ".FIT") {
    throw new Error(INVALID_FILE);
  }
  const end = headerSize + view.getUint32(4, true);
  if (end + 2 !== bytes.length ||
      (headerSize === 14 && view.getUint16(12, true) !== 0 && fitCrc16(bytes.subarray(0, 14)) !== 0) ||
      fitCrc16(bytes.subarray(0, end)) !== view.getUint16(end, true)) {
    throw new Error(INVALID_FILE);
  }

  const definitions = new Map();
  const decoder = new TextDecoder();
  let offset = headerSize;
  let fileType;
  let workout;
  const steps = [];

  function take(size) {
    const start = offset;
    offset += size;
    if (offset > end) throw new Error(INVALID_FILE);
    return start;
  }

  while (offset < end) {
    const header = bytes[take(1)];
    const compressed = Boolean(header & 0x80);
    const local = compressed ? (header >> 5) & 3 : header & 15;
    if (!compressed && (header & 0x40)) {
      const start = take(5);
      const architecture = bytes[start + 1];
      if (architecture > 1) throw new Error(INVALID_FILE);
      const littleEndian = architecture === 0;
      const global = view.getUint16(start + 2, littleEndian);
      const fields = Array.from({ length: bytes[start + 4] }, () => {
        const field = take(3);
        return { number: bytes[field], size: bytes[field + 1], type: bytes[field + 2] };
      });
      let developerSize = 0;
      if (header & 0x20) {
        const count = bytes[take(1)];
        for (let i = 0; i < count; i += 1) developerSize += bytes[take(3) + 1];
      }
      definitions.set(local, { global, littleEndian, fields, developerSize });
      continue;
    }

    const definition = definitions.get(local);
    if (!definition) throw new Error(INVALID_FILE);
    const { global, littleEndian, fields, developerSize } = definition;
    const message = {};
    for (const field of fields) {
      // Compressed headers carry the low timestamp bits in the record header.
      if (compressed && field.number === 253) continue;
      const start = take(field.size);
      if (global !== FILE_ID && global !== WORKOUT && global !== WORKOUT_STEP) continue;
      const value = readField(view, bytes, decoder, start, field, littleEndian);
      if (value !== undefined) message[field.number] = value;
    }
    take(developerSize);
    if (global === FILE_ID) {
      if (message[0] !== WORKOUT_FILE) throw new Error("Choose a FIT Workout file, such as a planned ride.");
      fileType = message[0];
    } else if (global === WORKOUT) {
      if (workout) throw new Error(INVALID_FILE);
      workout = message;
    } else if (global === WORKOUT_STEP) {
      steps.push(message);
    }
  }

  if (fileType !== WORKOUT_FILE) throw new Error("Choose a FIT Workout file, such as a planned ride.");
  if (!workout || !steps.length || workout[6] !== steps.length) throw new Error(INVALID_FILE);
  if (workout[4] !== undefined && workout[4] !== 0 && workout[4] !== CYCLING) {
    throw new Error("Choose a cycling workout.");
  }
  steps.sort((a, b) => a[254] - b[254]);
  for (const [index, step] of steps.entries()) {
    if (step[254] !== index || !Number.isInteger(step[1])) throw new Error(INVALID_FILE);
    if (REPEAT_TYPES.has(step[1]) &&
        (!Number.isInteger(step[2]) || step[2] >= index || !Number.isInteger(step[4]) || (step[1] === 6 && step[4] === 0))) {
      throw new Error("The workout contains an invalid repeat step.");
    }
  }
  return { name: typeof workout[8] === "string" ? workout[8].trim() : "", steps };
}

function readField(view, bytes, decoder, start, { size, type }, littleEndian) {
  if (type === 0x07) {
    const field = bytes.subarray(start, start + size);
    const terminator = field.indexOf(0);
    return decoder.decode(terminator < 0 ? field : field.subarray(0, terminator));
  }

  let value;
  if ((type === 0x00 || type === 0x02) && size === 1) value = view.getUint8(start);
  if (type === 0x84 && size === 2) value = view.getUint16(start, littleEndian);
  if (type === 0x86 && size === 4) value = view.getUint32(start, littleEndian);
  return value === 2 ** (size * 8) - 1 ? undefined : value;
}
