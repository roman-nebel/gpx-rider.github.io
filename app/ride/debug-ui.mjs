// Captures ride calculation context and exports the diagnostic journal from the sidebar.
import { state, els } from "../core/state.mjs";
import { ROAD_PHYSICS, SPEED_LIMITS, RIDE_DEBUG, MAX_TICK_SECONDS } from "../core/tuning.mjs";
import { recordDebugEvent, rideDebugLog } from "./debug-log.mjs";
import { rideLogSamples, rideLogSummary, rideLogWorkout } from "./recorder.mjs";
import { latestSimulationRecording } from "../simulation/simulation-recorder.mjs";

const CONTROL_IDS = new Set(["riderWeightInput", "bikeWeightInput", "inertiaInput", "maxRideSpeedInput", "autoCornerBrakingInput",
  "restingHeartRateInput", "maxHeartRateInput", "distanceUnitSelect", "energyUnitSelect", "timeFormatSelect", "durationFormatSelect", "ftpInput", "gradeIntervalInput", "workoutErgInput", "workoutAutoStartInput", "simulatorInput", "simulationModeSelect",
  "simulationAthleteSelect", "speedInput", "startBtn", "resetBtn", "pauseWorkoutBtn", "endWorkoutBtn", "workoutHudPlayBtn", "workoutHudEndBtn"]);

export async function initializeRideDebug() {
  const journal = rideDebugLog();
  journal.onStatus = updateDebugStatus;
  await journal.init();
  recordSession();
  captureRideDebug("app.ready");
  await captureSources();
}

function recordSession() {
  recordDebugEvent("app.session", {
    userAgent: navigator.userAgent, language: navigator.language,
    viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
    timeOriginMs: performance.timeOrigin, roadPhysics: ROAD_PHYSICS, speedLimits: SPEED_LIMITS, maxTickSeconds: MAX_TICK_SECONDS,
  });
}

async function captureSources() {
  const sources = await Promise.all(RIDE_DEBUG.source_paths.map(async path => {
    try {
      const response = await fetch(new URL(`../${path}`, import.meta.url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const digest = globalThis.crypto?.subtle
        ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)) : null;
      const sha256 = digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") : null;
      return { path, sha256, text };
    } catch (error) {
      return { path, error: error.message };
    }
  }));
  recordDebugEvent("app.sources", { sources });
}

function captureContext() {
  if (state.debugRouteRef !== state.route) {
    state.debugRouteRef = state.route;
    recordDebugEvent("context.route", { name: state.routeName, points: state.route });
  }
  if (state.debugWorkoutRef !== state.workout || state.debugWorkoutSessionRef !== state.workoutErg || state.debugSimulationWorkoutRef !== state.simulation?.workout) {
    state.debugWorkoutRef = state.workout;
    state.debugWorkoutSessionRef = state.workoutErg;
    state.debugSimulationWorkoutRef = state.simulation?.workout;
    recordDebugEvent("context.workout", { workout: state.workout, timedSteps: state.workoutErg?.steps ?? null, simulationTimedSteps: state.simulation?.workout?.steps ?? null });
  }
  if (state.debugTurnProfileRef !== state.turnSpeedProfile) {
    state.debugTurnProfileRef = state.turnSpeedProfile;
    recordDebugEvent("context.speed-profile", { profile: state.turnSpeedProfile });
  }
  const settings = {
    distanceUnits: state.distanceUnits, energyUnits: state.energyUnits, timeFormat: state.timeFormat, durationFormat: state.durationFormat,
    riderWeightKg: state.riderWeightKg, bikeWeightKg: state.bikeWeightKg, inertiaEnabled: state.inertiaEnabled,
    maxRideSpeedKph: state.maxRideSpeedKph, autoCornerBraking: state.autoCornerBraking,
    gradeUpdateIntervalSeconds: state.gradeUpdateIntervalSeconds, ftpWatts: state.ftpWatts,
    restingHeartRateBpm: state.restingHeartRateBpm, maxHeartRateBpm: state.maxHeartRateBpm,
    workoutErgEnabled: state.workoutErgEnabled, workoutAutoStart: state.workoutAutoStart,
    simulatorEnabled: state.simulatorEnabled, simulationMode: state.simulationMode, simulationAthlete: state.simulationAthlete,
    simulationConfig: state.simulation?.config ?? null,
  };
  const signature = JSON.stringify(settings);
  if (state.debugSettingsSignature !== signature) {
    state.debugSettingsSignature = signature;
    recordDebugEvent("context.settings", settings);
  }
}

export function captureRideDebug(type, details = null) {
  captureContext();
  const session = state.workoutErg;
  recordDebugEvent(type, {
    details,
    progressMeters: state.progressMeters, roadSpeedKph: state.roadSpeedKph,
    coasting: state.roadCoasting, finished: state.roadFinished, limited: state.roadSpeedLimited,
    pedaling: state.pedaling, loadFraction: state.trainerLoadFraction,
    brakeStrength: state.trainerBrakeStrength, uphillGradePercent: state.trainerUphillGradePercent,
    trainer: { speedKph: state.trainerSpeedKph, powerWatts: state.trainerPowerWatts, cadenceRpm: state.trainerCadenceRpm,
      speedSampleAt: state.trainerSpeedSampleAt, powerSampleAt: state.trainerPowerSampleAt, cadenceSampleAt: state.trainerCadenceSampleAt,
      heartRateBpm: state.trainerHeartRateBpm, caloriesKcal: state.trainerCaloriesKcal },
    strapHeartRateBpm: state.strapHeartRateBpm, powerCaloriesKcal: state.powerCaloriesKcal,
    workout: session ? { index: session.index, elapsedSeconds: session.elapsed, paused: session.paused,
      targetWatts: session.targetWatts, nextWriteAt: session.nextWriteAt, startedAtMs: session.startedAtMs } : null,
    simulation: state.simulation ? { mode: state.simulation.mode, ergStep: state.simulation.ergStep,
      workout: state.simulation.workout ? { index: state.simulation.workout.index, elapsed: state.simulation.workout.elapsed, ftp: state.simulation.workout.ftp } : null } : null,
  });
}

function updateDebugStatus(health) {
  if (!els.rideDebugStatus) return;
  const count = health.storedEvents + health.memoryEvents + health.pendingEvents;
  const warning = health.error ? ` ${health.error}${health.persistence === "memory" ? " Recent unsaved data is memory-only." : ""}` : "";
  const previous = health.previousStorageWarning ? " A previous session reported a storage problem; see the export." : "";
  const loss = health.droppedEvents ? ` ${health.droppedEvents} events were dropped.` : "";
  els.rideDebugStatus.textContent = `${count.toLocaleString("en-US")} diagnostic events. Recorded automatically; retained until cleared.${warning}${previous}${loss}`;
}

export function handleDebugControl(event) {
  const control = event.target.closest?.("button, input, select");
  if (!control || !CONTROL_IDS.has(control.id)) return;
  // Clicks on inputs duplicate change events; only record button clicks here.
  if (event.type === "click" && control.tagName !== "BUTTON") return;
  captureRideDebug("ui.control", { event: event.type, id: control.id,
    value: control.type === "checkbox" ? control.checked : control.value });
}

export function handleDebugError(event) {
  recordDebugEvent("app.error", { message: event.message, filename: event.filename ? new URL(event.filename, location.href).pathname : null,
    line: event.lineno, column: event.colno, error: event.error ?? event.reason });
}

export function flushRideDebug() {
  captureRideDebug("app.checkpoint", { visibility: document.visibilityState });
  void rideDebugLog().flush();
}

export async function downloadRideDebug() {
  els.downloadRideDebugBtn.disabled = true;
  els.clearRideDebugBtn.disabled = true;
  try {
    captureRideDebug("export.snapshot");
    recordDebugEvent("export.recordings", { real: { summary: rideLogSummary(), samples: rideLogSamples(), workout: rideLogWorkout() },
      simulation: latestSimulationRecording(), workoutResult: state.workoutResult, activeWorkoutSummary: state.workoutErg?.summary ?? null,
      etaEstimator: state.rideEstimator });
    let blob = await rideDebugLog().export();
    const compressed = typeof CompressionStream === "function";
    if (compressed) blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gpx-rider-debug-${new Date().toISOString().replaceAll(":", "-")}.jsonl${compressed ? ".gz" : ""}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), RIDE_DEBUG.download_url_lifetime_ms);
  } catch (error) {
    els.rideDebugStatus.textContent = `Could not export diagnostics: ${error.message}`;
  } finally {
    els.downloadRideDebugBtn.disabled = false;
    els.clearRideDebugBtn.disabled = false;
  }
}

export async function clearRideDebug() {
  if (!window.confirm("Delete all saved diagnostic events? Your ride and FIT recordings will be kept.")) return;
  els.clearRideDebugBtn.disabled = true;
  els.downloadRideDebugBtn.disabled = true;
  try {
    await rideDebugLog().clear();
    recordSession();
    state.debugRouteRef = state.debugWorkoutRef = state.debugWorkoutSessionRef = undefined;
    state.debugSimulationWorkoutRef = state.debugTurnProfileRef = undefined;
    state.debugSettingsSignature = null;
    captureRideDebug("app.log-cleared");
    await captureSources();
    await rideDebugLog().flush();
  } catch (error) {
    els.rideDebugStatus.textContent = `Could not clear diagnostics: ${error.message}`;
  } finally {
    els.clearRideDebugBtn.disabled = false;
    els.downloadRideDebugBtn.disabled = false;
  }
}
