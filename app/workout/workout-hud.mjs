// Owns the dock workout timeline and the workout step widgets at the top of the map.
import { els, state } from "../core/state.mjs";
import { WORKOUT_HUD_NEXT_STEP_SECONDS } from "../core/tuning.mjs";
import { formatDuration } from "../core/units.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { updateWorkoutMeterTargets } from "../ride/training-zones.mjs";
import { previewNextWorkoutStep } from "./workout-preview.mjs";
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
  state.workoutHudPreview = total ? { profile, fills } : null;
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
  els.workoutHudMiniChart.style.backgroundImage = miniChartBackground(profile);
  updateWorkoutHud();
  updateWorkoutMeterTargets();
}

export function currentWorkoutHudStep() {
  const session = state.simulation?.workout ?? state.workoutErg;
  return session && !session.paused ? session.steps[session.index] : null;
}

export function updateWorkoutHud() {
  const session = state.simulation?.workout ?? state.workoutErg;
  const result = session ? null : state.workoutResult;
  updateWorkoutControls();
  updateNextWorkoutStep(session);
  els.workoutHudMiniChart.hidden = Boolean(result || session);
  const summary = els.workoutHudSummary;
  const profile = state.workoutHudPreview?.profile;
  els.workoutHud.classList.toggle("is-complete", Boolean(result));
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
  const step = session?.steps[session.index];

  const index = session?.index ?? 0;
  const elapsed = session?.elapsed ?? 0;
  const duration = step?.durationSeconds;
  setText(els.workoutHudCurrent, step?.name ?? state.workout?.name ?? "");
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
    setText(els.workoutHudRemaining, formatDuration(Math.ceil(Math.max(0, duration - elapsed)), "padded-clock"));
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

function updateWorkoutControls() {
  const session = state.workoutErg;
  const countdown = state.workoutCountdown;
  const play = els.workoutHudPlayBtn;
  const action = session?.paused ? "Resume workout" : session ? "Pause workout"
    : state.workoutResult ? "Restart workout" : "Start workout";
  const playState = countdown ? "countdown" : !session ? "start" : session.paused ? "play" : "pause";
  if (play.dataset.state !== playState) play.dataset.state = playState;
  const label = countdown ? `Starting in ${countdown.seconds} seconds` : action;
  setButtonLabel(play, label);
  play.hidden = Boolean(state.simulatorEnabled);
  els.workoutErgInput.disabled = Boolean(state.simulatorEnabled);
  play.disabled = Boolean(countdown);
  els.workoutHudCountdown.hidden = !countdown;
  if (countdown) setText(els.workoutHudCountdown, String(countdown.seconds));

  const endLabel = countdown ? "Cancel start" : "End workout";
  setButtonLabel(els.workoutHudEndBtn, endLabel);
  els.workoutHudEndBtn.hidden = !(session || countdown);
  els.workoutCardActions.hidden = els.workoutHudEndBtn.hidden;
  els.pauseWorkoutBtn.hidden = !session;
  setText(els.pauseWorkoutBtn, session?.paused ? "Resume" : "Pause");
  els.endWorkoutBtn.hidden = els.workoutHudEndBtn.hidden;
  setText(els.endWorkoutBtn, endLabel);
}

function setButtonLabel(button, label) {
  if (button.title === label) return;
  button.title = label;
  button.setAttribute("aria-label", label);
}

function miniChartBackground(profile) {
  if (!profile?.extent) return "";
  const stops = profile.intervals.flatMap(({ start, end, power }) => {
    const width = end - start;
    return workoutZoneBands(power, state.ftpWatts).map((band) => {
      const left = (start + width * band.start) / profile.extent * 100;
      const right = (start + width * band.end) / profile.extent * 100;
      return `${band.color} ${left}% ${right}%`;
    });
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function updateNextWorkoutStep(session) {
  const next = session?.steps[session.index + 1];
  const remaining = session ? session.steps[session.index]?.durationSeconds - session.elapsed : Infinity;
  const showNext = Boolean(next) && remaining <= WORKOUT_HUD_NEXT_STEP_SECONDS;
  els.workoutHudNext.hidden = !showNext;
  if (!showNext) return;

  setText(els.workoutHudNextName, next.name);
  const preview = previewNextWorkoutStep(next, state.simulation?.workout?.ftp ?? state.ftpWatts);
  setText(els.workoutHudNextDuration, preview.duration);
  setText(els.workoutHudNextPower, preview.power);
  els.workoutHudNextPower.parentElement.hidden = !preview.power;
  els.workoutHudNextHeartRate.hidden = !preview.heartRate;
  els.workoutHudNextCadence.hidden = !preview.cadence;
  els.workoutHudNextSpeed.hidden = !preview.speed;
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
  if (!power) return "var(--workout-free-power-gradient)";
  const bands = workoutZoneBands(power, state.ftpWatts);
  if (bands.length === 1) return bands[0].color;
  const stops = bands.map(({ start, end, color }) => `${color} ${start * 100}% ${end * 100}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
