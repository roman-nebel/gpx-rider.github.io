// Reads MyWhoosh workout exports and preserves power targets as fractions of FTP.
import { WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";

const XML_STEP_NAMES = new Map([
  ["Warmup", "Warmup"], ["Cooldown", "Cooldown"], ["Ramp", "Ramp"],
  ["SteadyState", "Interval"], ["FreeRide", "Free ride"],
]);
const JSON_STEP_NAMES = new Map([
  ["E_WarmUp", "Warmup"], ["E_CoolDown", "Cooldown"], ["E_Ramp", "Ramp"],
  ["E_Normal", "Interval"], ["E_FreeRide", "Free ride"],
]);

export function decodeMyWhooshXml(text) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const root = document.documentElement;
  const workout = root.querySelector(":scope > workout");
  const sport = root.querySelector(":scope > sportType")?.textContent.trim();
  const durationType = root.querySelector(":scope > durationType")?.textContent.trim();
  if (document.doctype || root.localName !== "workout_file" || sport !== "bike" ||
      (durationType && durationType !== "time") || !workout?.children.length) {
    throw new Error("Choose a cycling workout XML file.");
  }

  const steps = [];
  for (const step of workout.children) {
    if (step.localName === "IntervalsT") {
      const repeats = Number(step.getAttribute("Repeat"));
      if (!Number.isSafeInteger(repeats) || repeats < 1 ||
          steps.length + 2 * repeats > WORKOUT_PROFILE_STEP_LIMIT) {
        throw new Error("The XML workout contains an invalid or excessive repeat count.");
      }
      const effort = makeStep("Interval", step.getAttribute("OnDuration"),
        step.getAttribute("Cadence"), [step.getAttribute("OnPower")]);
      const recovery = makeStep("Interval", step.getAttribute("OffDuration"),
        null, [step.getAttribute("OffPower")]);
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        steps.push({ ...effort }, { ...recovery });
      }
      continue;
    }
    const name = XML_STEP_NAMES.get(step.localName);
    if (!name) throw new Error(`Unsupported XML workout step: ${step.localName}.`);
    const power = step.hasAttribute("Power") ? [step.getAttribute("Power")] : [
      step.getAttribute("PowerLow"),
      step.getAttribute("PowerHigh"),
    ];
    steps.push(makeStep(name, step.getAttribute("Duration"), step.getAttribute("Cadence"), power));
  }
  return { name: root.querySelector(":scope > name")?.textContent.trim() ?? "", steps };
}

export function decodeMyWhooshJson(text) {
  let workout;
  try {
    workout = JSON.parse(text);
  } catch {
    throw new Error("The workout JSON is invalid.");
  }
  if (workout?.Mode !== "E_Ride" || !Array.isArray(workout.WorkoutStepsArray) ||
      !workout.WorkoutStepsArray.length) {
    throw new Error("Choose a MyWhoosh cycling workout JSON file.");
  }

  const steps = workout.WorkoutStepsArray.map((step) => {
    const name = JSON_STEP_NAMES.get(step?.StepType);
    if (!name) throw new Error("The JSON workout contains an unsupported step type.");
    const ramp = name === "Warmup" || name === "Cooldown" || name === "Ramp";
    return makeStep(name, step.Time, step.Rpm, ramp ? [step.StartPower, step.EndPower] : [step.Power]);
  });
  return { name: typeof workout.Name === "string" ? workout.Name.trim() : "", steps };
}

function makeStep(name, duration, cadence, powerValues) {
  const durationSeconds = readNumber(duration);
  if (durationSeconds <= 0) throw new Error("Workout steps need a positive duration.");
  const cadenceRpm = cadence == null ? 0 : readNumber(cadence);
  const power = name === "Free ride" ? null : powerValues.map(readNumber);
  return { name, durationSeconds, cadenceRpm, power };
}

function readNumber(value) {
  if (typeof value === "string" && value.trim()) value = Number(value);
  if (!Number.isFinite(value) || value < 0) throw new Error("The workout contains an invalid step value.");
  return value;
}
