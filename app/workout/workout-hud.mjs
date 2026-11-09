// Owns the dock workout timeline and the current-step chip at the top of the map.
import { els, state } from "../core/state.mjs";
import { POWER_ZONE_DEFINITIONS } from "../core/tuning.mjs";
import { formatDuration } from "../core/units.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { updateWorkoutMeterTargets } from "../ride/training-zones.mjs";
import { buildWorkoutProfile, powerZone } from "./workout-profile.mjs";

export function registerWorkoutHud() {
  registerHudComponent({ id: "workout-step", region: "center", weight: 5, element: els.workoutHud });
}

export function syncWorkoutHud(steps, total) {
  const profile = total === steps.length && total > 0 ? buildWorkoutProfile(steps, state.ftpWatts) : null;
  state.workoutHudPreview = total ? { step: steps[0], profile } : null;
  els.workoutHud.hidden = !total;
  els.workoutHudTrack.hidden = !profile;

  const segments = document.createDocumentFragment();
  if (profile) {
    for (const interval of profile.intervals) {
      const segment = document.createElement("span");
      const power = interval.power;
      const scale = power?.unit === "% FTP" ? 100 : state.ftpWatts;
      const zone = power?.unit ? power.zone ?? powerZone((power.start + power.end) / 2, scale) : null;
      segment.style.setProperty("--workout-segment-color", POWER_ZONE_DEFINITIONS[zone]?.color ??
        (power?.unit === "W" ? "var(--blue-soft)" : "var(--faint)"));
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
  const elapsed = session?.elapsed ?? 0;
  const duration = step.durationSeconds;
  setText(els.workoutHudCurrent, step.name);
  const timedStep = Number.isFinite(duration) && duration > 0;
  els.workoutHudStepProgress.hidden = !timedStep;
  els.workoutHudRemaining.hidden = !timedStep;
  if (timedStep) {
    els.workoutHudStepProgress.value = elapsed / duration;
    setText(els.workoutHudRemaining, `${formatDuration(Math.ceil(Math.max(0, duration - elapsed)))} left`);
  }

  const profile = state.workoutHudPreview?.profile;
  if (!profile) return;
  const index = session?.index ?? 0;
  const interval = profile.intervals[index];
  const position = (interval?.start ?? 0) + (profile.timed ? elapsed : 0);
  els.workoutHudCursor.hidden = !profile.timed;
  els.workoutHudCursor.style.left = `${Math.min(100, position / profile.extent * 100)}%`;
  setText(els.workoutHudTime, profile.timed
    ? `${formatDuration(Math.floor(position))}/${formatDuration(profile.extent)}`
    : `Step ${index + 1} / ${profile.intervals.length}`);
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
