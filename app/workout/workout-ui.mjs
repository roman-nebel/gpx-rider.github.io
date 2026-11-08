// Handles the local workout file picker, selected workout, and its sidebar card.
import { els, state } from "../core/state.mjs";
import { readJson, removeStored, writeJsonCommitted } from "../storage/storage.mjs";
import { decodeFitWorkout } from "./fit-workout.mjs";
import { decodeMyWhooshJson, decodeMyWhooshXml } from "./mywhoosh-workout.mjs";
import { renderWorkoutChart } from "./workout-chart.mjs";
import { normalizeWorkoutStep } from "./workout-step.mjs";
import { previewWorkoutStep } from "./workout-preview.mjs";

const WORKOUT_STORAGE_KEY = "gpx-rider:selected-workout";

export function restoreWorkout() {
  state.workout = readJson(WORKOUT_STORAGE_KEY);
  renderWorkout();
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
    els.workoutChart.replaceChildren();
    els.workoutSteps.replaceChildren();
    return;
  }

  els.workoutName.textContent = workout.name;
  els.workoutStepCount.textContent = `${workout.steps.length} ${workout.steps.length === 1 ? "step" : "steps"}`;
  const normalized = workout.steps.map(normalizeWorkoutStep);
  const steps = normalized.map((step) => previewWorkoutStep(step, state.ftpWatts));
  els.workoutFtpWarning.hidden = Boolean(state.ftpWatts) || !steps.some((step) => step.needsFtp);

  renderWorkoutChart(els.workoutChart, normalized, state.ftpWatts);

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
