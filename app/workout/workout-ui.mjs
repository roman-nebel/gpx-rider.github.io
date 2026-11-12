// Handles the local workout file picker, selected workout, and its sidebar card.
import { WORKOUT_PREVIEW_STEP_LIMIT, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { els, state } from "../core/state.mjs";
import { readJson, removeStored, writeJsonCommitted } from "../storage/storage.mjs";
import { decodeFitWorkout } from "./fit-workout.mjs";
import { decodeMyWhooshJson, decodeMyWhooshXml } from "./mywhoosh-workout.mjs";
import { syncWorkoutHud } from "./workout-hud.mjs";
import { stopWorkoutErg } from "./workout-erg.mjs";
import { renderWorkoutChart } from "./workout-chart.mjs";
import { normalizeWorkoutStep } from "./workout-step.mjs";
import { previewWorkoutStep } from "./workout-preview.mjs";

const WORKOUT_STORAGE_KEY = "gpx-rider:selected-workout";

export function restoreWorkout() {
  state.workout = readJson(WORKOUT_STORAGE_KEY);
  renderWorkout();
  if (location.hostname === "127.0.0.1" && new URLSearchParams(location.search).has("next-step-preview")) {
    // Temporary HUD example. Keep the selected workout and trainer session intact.
    const steps = [
      { 0: "Sweet spot", 1: 0, 2: 480000, 3: 4, 5: 1220, 6: 1220 },
      { 0: "Recovery", 1: 0, 2: 180000, 3: 4, 5: 1130, 6: 1110, 19: 3, 21: 85, 22: 95 },
    ].map(normalizeWorkoutStep);
    steps[1].targets[0].ramp = true;
    steps[1].targets.push(
      { label: "Heart rate", unit: "bpm", bounds: [{ value: 120, unit: "bpm" }, { value: 135, unit: "bpm" }] },
      { label: "Speed", unit: "m/s", bounds: [{ value: 8.333, unit: "m/s" }, { value: 10, unit: "m/s" }] },
    );
    syncWorkoutHud(steps, steps.length, { steps, index: 0, elapsed: 456 });
  }
}

export async function importWorkout(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  input.disabled = true;
  els.clearWorkoutBtn.disabled = true;
  setWorkoutError("");

  try {
    const workout = await readWorkoutFile(file);
    workout.name ||= file.name.replace(/\.(fit|xml|json)$/i, "");
    if (!await writeJsonCommitted(WORKOUT_STORAGE_KEY, workout)) {
      throw new Error("This browser could not save the workout.");
    }
    stopWorkoutErg();
    state.workout = workout;
    renderWorkout();
    els.workoutCard.scrollIntoView({ block: "nearest" });
  } catch (error) {
    setWorkoutError(`Import failed. ${error.message}`);
    els.workoutError.scrollIntoView({ block: "nearest" });
  } finally {
    input.disabled = false;
    els.clearWorkoutBtn.disabled = false;
  }
}

async function readWorkoutFile(file) {
  const extension = file.name.split(".").at(-1).toLowerCase();
  switch (extension) {
    case "fit": return decodeFitWorkout(await file.arrayBuffer());
    case "xml": return decodeMyWhooshXml(await file.text());
    case "json": return decodeMyWhooshJson(await file.text());
    default: throw new Error("Choose a FIT, XML, or JSON workout file.");
  }
}

export async function clearWorkout() {
  els.workoutFile.disabled = true;
  els.clearWorkoutBtn.disabled = true;
  try {
    if (await removeStored(WORKOUT_STORAGE_KEY) === false) {
      setWorkoutError("This browser could not remove the saved workout.");
      return;
    }
    stopWorkoutErg();
    state.workout = null;
    setWorkoutError("");
    renderWorkout();
  } catch {
    setWorkoutError("This browser could not remove the saved workout.");
  } finally {
    els.workoutFile.disabled = false;
    els.clearWorkoutBtn.disabled = false;
  }
  if (!state.workout) els.workoutFile.focus();
}

export function renderWorkout() {
  const workout = state.workout;
  els.workoutCard.hidden = !workout;
  els.workoutChip.hidden = !workout;
  els.workoutChipName.textContent = workout?.name ?? "";
  els.workoutChip.title = workout?.name ?? "";
  if (!workout) {
    syncWorkoutHud([], 0);
    els.workoutChart.replaceChildren();
    els.workoutSteps.replaceChildren();
    return;
  }

  els.workoutName.textContent = workout.name;
  const total = workout.steps.length;
  const previewCount = Math.min(total, WORKOUT_PREVIEW_STEP_LIMIT);
  els.workoutStepCount.textContent = previewCount < total
    ? `${total} steps · Showing first ${previewCount}`
    : `${total} ${total === 1 ? "step" : "steps"}`;
  const normalizationLimit = Math.max(WORKOUT_PREVIEW_STEP_LIMIT, WORKOUT_PROFILE_STEP_LIMIT + 1);
  const normalized = workout.steps.slice(0, normalizationLimit).map(normalizeWorkoutStep);
  const steps = normalized.slice(0, previewCount).map((step) =>
    previewWorkoutStep(step, state.ftpWatts, state.maxHeartRateBpm));
  els.workoutFtpWarning.hidden = Boolean(state.ftpWatts) ||
    !normalized.some((step) => step.targets.some((target) => target.needsFtp));

  renderWorkoutChart(els.workoutChart, normalized, state.ftpWatts);
  syncWorkoutHud(normalized, total);

  const items = document.createDocumentFragment();
  steps.forEach((step, index) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "workout-step-name";
    name.textContent = step.name;
    const detail = document.createElement("span");
    detail.className = "workout-step-detail";
    const stepNumber = document.createElement("span");
    stepNumber.className = "workout-step-number";
    stepNumber.textContent = `${index + 1}.`;
    detail.append(stepNumber, document.createTextNode(` ${step.detail}`));
    item.append(detail, name);
    if (step.notes) {
      const notes = document.createElement("span");
      notes.className = "workout-step-notes";
      notes.textContent = step.notes;
      item.append(notes);
    }
    items.append(item);
  });
  els.workoutSteps.replaceChildren(items);
}

function setWorkoutError(message) {
  els.workoutError.hidden = !message;
  els.workoutError.textContent = message;
}
