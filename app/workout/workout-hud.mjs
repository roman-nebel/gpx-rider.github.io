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
  const profile = total === steps.length && total > 0 ? buildWorkoutProfile(steps, state.ftpWatts) : null;
  const intervals = profile?.intervals ?? (total ? buildWorkoutProfile(steps.slice(0, 1), state.ftpWatts).intervals : []);
  const backgrounds = intervals.map(({ power }) => zoneBackground(power));
  state.workoutHudPreview = total ? { step: steps[0], profile, backgrounds } : null;
  els.workoutHud.hidden = !total;
  els.workoutHudTrack.hidden = !profile;

  const segments = document.createDocumentFragment();
  if (profile) {
    for (const [index, interval] of profile.intervals.entries()) {
      const segment = document.createElement("span");
      const power = interval.power;
      segment.style.setProperty("--workout-segment-background", backgrounds[index]);
      segment.style.flexGrow = interval.end - interval.start;
      segment.classList.toggle("workout-timeline-hatched", Boolean(power?.relative && !state.ftpWatts));
      segments.append(segment);
    }
  }
  els.workoutHudChart.replaceChildren(segments);
  updateWorkoutHud();
  updateWorkoutMeterTargets();
}

export function currentWorkoutHudStep() {
  const session = state.workoutErg;
  return session ? session.steps[session.index] : state.workoutHudPreview?.step;
}

export function updateWorkoutHud() {
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
    const background = state.workoutHudPreview?.backgrounds[index] ?? "var(--faint)";
    if (track.style.getPropertyValue("--workout-step-background") !== background) {
      track.style.setProperty("--workout-step-background", background);
    }
    progress.value = elapsed / duration;
    track.style.setProperty("--workout-step-elapsed", `${progress.position * 100}%`);
    setText(els.workoutHudRemaining, `${formatDuration(Math.ceil(Math.max(0, duration - elapsed)))} left`);
  }

  const profile = state.workoutHudPreview?.profile;
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

function zoneBackground(power) {
  const bands = workoutZoneBands(power, state.ftpWatts);
  if (bands.length === 1) return bands[0].color;
  const stops = bands.map(({ start, end, color }) => `${color} ${start * 100}% ${end * 100}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
