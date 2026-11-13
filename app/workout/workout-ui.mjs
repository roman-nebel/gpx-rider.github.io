// Handles the local workout file picker, selected workout, and its sidebar card.
import { WORKOUT_PREVIEW_STEP_LIMIT, WORKOUT_PROFILE_STEP_LIMIT } from "../core/tuning.mjs";
import { els, state } from "../core/state.mjs";
import { readJson, removeStored, writeJsonCommitted } from "../storage/storage.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import { setPickerSelection } from "../top-bar/selection-picker.mjs";
import { decodeFitWorkout } from "./fit-workout.mjs";
import { decodeMyWhooshJson, decodeMyWhooshXml } from "./mywhoosh-workout.mjs";
import { syncWorkoutHud } from "./workout-hud.mjs";
import { stopWorkoutErg } from "./workout-erg.mjs";
import { renderWorkoutChart } from "./workout-chart.mjs";
import { normalizeWorkoutStep } from "./workout-step.mjs";
import { previewWorkoutStep } from "./workout-preview.mjs";

const WORKOUT_STORAGE_KEY = "gpx-rider:selected-workout";

export function restoreWorkout() {
  els.workoutAutoStartInput.checked = state.workoutAutoStart;
  state.workout = readJson(WORKOUT_STORAGE_KEY);
  renderWorkout();
}

export function updateWorkoutAutoStart() {
  state.workoutAutoStart = els.workoutAutoStartInput.checked;
  state.workoutAutoStartAttempted = Boolean(state.workoutErg || state.workoutCountdown || state.workoutResult);
  saveSettings();
}

export function openWorkoutGallery() {
  els.workoutImportError.hidden = true;
  els.workoutGalleryDialog.showModal();
}

export async function importWorkout(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  input.disabled = true;
  els.clearWorkoutBtn.disabled = true;
  setWorkoutError("");
  els.workoutImportError.hidden = true;

  try {
    const workout = await readWorkoutFile(file);
    workout.name ||= file.name.replace(/\.(fit|xml|json)$/i, "");
    if (!await writeJsonCommitted(WORKOUT_STORAGE_KEY, workout)) {
      throw new Error("This browser could not save the workout.");
    }
    stopWorkoutErg();
    state.workout = workout;
    state.workoutAutoStartAttempted = false;
    renderWorkout();
    els.workoutGalleryDialog.close();
    els.workoutCard.scrollIntoView({ block: "nearest" });
  } catch (error) {
    els.workoutImportError.textContent = `Import failed. ${error.message}`;
    els.workoutImportError.hidden = false;
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
    state.workoutAutoStartAttempted = false;
    setWorkoutError("");
    renderWorkout();
  } catch {
    setWorkoutError("This browser could not remove the saved workout.");
  } finally {
    els.workoutFile.disabled = false;
    els.clearWorkoutBtn.disabled = false;
  }
  if (!state.workout) els.workoutPicker.focus();
}

export function renderWorkout() {
  const workout = state.workout;
  els.workoutCard.hidden = !workout;
  els.clearWorkoutBtn.hidden = !workout;
  setPickerSelection(els.workoutPicker, workout ? workout.name || "Untitled workout" : null);
  if (!workout) {
    syncWorkoutHud([], 0);
    els.workoutChart.replaceChildren();
    els.workoutSteps.replaceChildren();
    return;
  }

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
