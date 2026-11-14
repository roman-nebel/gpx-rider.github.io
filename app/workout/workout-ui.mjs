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
import { previewNextWorkoutStep, previewWorkoutStep } from "./workout-preview.mjs";

const WORKOUT_STORAGE_KEY = "gpx-rider:selected-workout";
const STEP_TARGET_ICONS = [
  ["heartRate", "heart-rate"],
  ["cadence", "cadence"],
  ["speed", "speed"],
];

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
    ? `(${total}, showing first ${previewCount})`
    : `(${total})`;
  const normalizationLimit = Math.max(WORKOUT_PREVIEW_STEP_LIMIT, WORKOUT_PROFILE_STEP_LIMIT + 1);
  const normalized = workout.steps.slice(0, normalizationLimit).map(normalizeWorkoutStep);
  els.workoutFtpWarning.hidden = Boolean(state.ftpWatts) ||
    !normalized.some((step) => step.targets.some((target) => target.needsFtp));

  renderWorkoutChart(els.workoutChart, normalized, state.ftpWatts);
  syncWorkoutHud(normalized, total);

  const items = document.createDocumentFragment();
  normalized.slice(0, previewCount).forEach((step, index) => {
    const item = document.createElement("li");
    const heading = document.createElement("span");
    heading.className = "workout-step-heading";
    const stepNumber = document.createElement("span");
    stepNumber.className = "workout-step-number";
    stepNumber.textContent = `${index + 1}.`;
    const name = document.createElement("span");
    name.className = "workout-step-name";
    name.textContent = step.name;
    heading.append(stepNumber, name);
    item.append(heading, buildStepMetrics(step));
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

function buildStepMetrics(step) {
  const { detail } = previewWorkoutStep(step, state.ftpWatts, state.maxHeartRateBpm);
  const preview = previewNextWorkoutStep(step, state.ftpWatts);
  const metrics = document.createElement("span");
  metrics.className = "workout-step-list-metrics";
  metrics.setAttribute("role", "group");
  metrics.setAttribute("aria-label", detail);
  metrics.title = detail;

  for (const [target, icon] of STEP_TARGET_ICONS) {
    if (preview[target]) metrics.append(buildTargetIcon(icon));
  }
  if (preview.power) {
    const power = document.createElement("span");
    power.className = "workout-next-power";
    power.setAttribute("aria-hidden", "true");
    const value = document.createElement("span");
    value.textContent = preview.power;
    power.append(buildTargetIcon("bolt"), value);
    metrics.append(power);
  }
  const duration = document.createElement("span");
  duration.className = "workout-step-list-duration";
  duration.setAttribute("aria-hidden", "true");
  const time = document.createElement("span");
  time.textContent = preview.duration;
  duration.append(buildTargetIcon("clock"), time);
  metrics.append(duration);
  return metrics;
}

function buildTargetIcon(icon) {
  const element = document.createElement("span");
  element.className = `workout-next-icon workout-next-${icon}`;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function setWorkoutError(message) {
  els.workoutError.hidden = !message;
  els.workoutError.textContent = message;
}
