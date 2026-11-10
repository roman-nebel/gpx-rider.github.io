// Owns the dock workout timeline and the current-step chip at the top of the map.
import { els, state } from "../core/state.mjs";
import { formatDuration } from "../core/units.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { updateWorkoutMeterTargets } from "../ride/training-zones.mjs";
import { buildWorkoutProfile, workoutZoneBands } from "./workout-profile.mjs";

export function registerWorkoutHud() {
  registerHudComponent({ id: "workout-step", region: "center", weight: 5, element: els.workoutHud });
}

export function syncWorkoutHud(steps, total) {
  if (state.workoutResult?.workout !== state.workout) state.workoutResult = null;
  const profile = total === steps.length && total > 0 ? buildWorkoutProfile(steps, state.ftpWatts) : null;
  const intervals = profile?.intervals ?? (total ? buildWorkoutProfile(steps.slice(0, 1), state.ftpWatts).intervals : []);
  const fills = intervals.map(({ power }) => ({
    background: zoneBackground(power),
    hatched: Boolean(power?.relative && !state.ftpWatts),
  }));
  state.workoutHudPreview = total ? { step: steps[0], profile, fills } : null;
  els.workoutHud.hidden = !total;
  els.workoutHudTrack.hidden = !profile;

  const segments = document.createDocumentFragment();
  if (profile) {
    for (const [index, interval] of profile.intervals.entries()) {
      const segment = document.createElement("span");
      const { background, hatched } = fills[index];
      segment.style.setProperty("--workout-segment-background", background);
      segment.style.flexGrow = interval.end - interval.start;
      segment.classList.toggle("workout-power-hatched", hatched);
      segments.append(segment);
    }
  }
  els.workoutHudChart.replaceChildren(segments);
  updateWorkoutHud();
  updateWorkoutMeterTargets();
}

export function currentWorkoutHudStep() {
  if (state.workoutResult) return null;
  const session = state.workoutErg;
  return session ? session.steps[session.index] : state.workoutHudPreview?.step;
}

export function updateWorkoutHud() {
  const result = state.workoutResult;
  const summary = els.workoutHudSummary;
  const profile = state.workoutHudPreview?.profile;
  els.workoutHudChart.classList.toggle("workout-timeline-complete", Boolean(result));
  if (result) {
    if (summary.hidden) {
      renderWorkoutSummary(summary, result);
      updateWorkoutMeterTargets();
    }
    summary.hidden = false;
    els.workoutHudStepTrack.hidden = true;
    els.workoutHudRemaining.hidden = true;
    setText(els.workoutHudCurrent, "Workout complete");
    if (profile?.timed) {
      const time = formatDuration(profile.extent);
      setText(els.workoutHudTime, `${time}/${time}`);
    }
    return;
  }
  summary.hidden = true;
  const step = currentWorkoutHudStep();
  if (!step) return;

  const session = state.workoutErg;
  const index = session?.index ?? 0;
  const elapsed = session?.elapsed ?? 0;
  const duration = step.durationSeconds;
  setText(els.workoutHudCurrent, step.name);
  const timedStep = Number.isFinite(duration) && duration > 0;
  const track = els.workoutHudStepTrack;
  track.hidden = !timedStep;
  els.workoutHudRemaining.hidden = !timedStep;
  if (timedStep) {
    const progress = els.workoutHudStepProgress;
    const fill = state.workoutHudPreview?.fills[index];
    const background = fill?.background ?? "var(--faint)";
    if (track.style.getPropertyValue("--workout-step-background") !== background) {
      track.style.setProperty("--workout-step-background", background);
    }
    track.classList.toggle("workout-power-hatched", Boolean(fill?.hatched));
    progress.value = elapsed / duration;
    track.style.setProperty("--workout-step-elapsed", `${progress.position * 100}%`);
    setText(els.workoutHudRemaining, formatDuration(Math.ceil(Math.max(0, duration - elapsed))));
  }

  if (!profile) return;
  const interval = profile.intervals[index];
  const position = (interval?.start ?? 0) + (profile.timed ? elapsed : 0);
  if (profile.timed) {
    const chart = els.workoutHudChart;
    const active = position > 0 ? chart.children[index] : null;
    const previous = state.workoutHudPreview.activeSegment;
    if (active !== previous) {
      previous?.classList.remove("workout-timeline-active");
      active?.classList.add("workout-timeline-active");
      state.workoutHudPreview.activeSegment = active;
    }
    active?.style.setProperty("--workout-segment-elapsed", `${Math.min(100, elapsed / duration * 100)}%`);
  }
  setText(els.workoutHudTime, profile.timed
    ? `${formatDuration(Math.floor(position))}/${formatDuration(profile.extent)}`
    : `Step ${index + 1} / ${profile.intervals.length}`);
}

function renderWorkoutSummary(container, result) {
  const measurements = [
    ["On target", result.onTarget, "%"],
    ["Avg power", result.power, " W"],
    result.cadence !== null ? ["Avg cadence", result.cadence, " rpm"] : ["Avg HR", result.heartRate, " bpm"],
  ];
  const items = document.createDocumentFragment();
  for (const [label, value, unit] of measurements) {
    if (value === null) continue;
    const item = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = `${value}${unit}`;
    item.append(term, detail);
    items.append(item);
  }
  container.replaceChildren(items);
}

function zoneBackground(power) {
  const bands = workoutZoneBands(power, state.ftpWatts);
  if (bands.length === 1) return bands[0].color;
  const stops = bands.map(({ start, end, color }) => `${color} ${start * 100}% ${end * 100}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
