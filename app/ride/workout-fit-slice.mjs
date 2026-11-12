// Finds and rebases the recorded workout portion of a FIT activity.

export function workoutFitRange(boundaries, sampleCount, findLegacySample) {
  const first = boundaries.findIndex(({ stepIndex }) => Number.isInteger(stepIndex));
  if (first < 0) return null;
  const last = boundaries.findLastIndex(({ stepIndex }) => Number.isInteger(stepIndex));
  const start = boundaries[first];
  const end = boundaries[last + 1];
  const startIndex = start.sampleIndex ?? findLegacySample(start);
  const endIndex = end ? end.sampleIndex ?? findLegacySample(end) : sampleCount;
  return endIndex - startIndex >= 2 ? { first, last, startIndex, endIndex } : null;
}

export function sliceWorkoutFit({ samples, summary, workout, workoutLaps }, range) {
  const { first, last, startIndex, endIndex } = range;
  const start = workoutLaps[first];
  const end = workoutLaps[last + 1] ?? {
    startMs: summary.endTimeMs ?? samples.at(-1).t * 1000,
    timerSeconds: summary.totalTimerSeconds,
    distanceMeters: summary.totalDistanceMeters,
    caloriesKcal: summary.totalCalories,
  };
  const timer = end.timerSeconds - start.timerSeconds;
  const distance = (value) => Math.max(0, value - start.distanceMeters);
  const calories = (value) => Number.isFinite(value) && Number.isFinite(start.caloriesKcal)
    ? Math.max(0, value - start.caloriesKcal) : null;
  return {
    workout,
    workoutLaps: workoutLaps.slice(first, last + 1).map((lap) => ({
      ...lap,
      timerSeconds: lap.timerSeconds - start.timerSeconds,
      distanceMeters: distance(lap.distanceMeters),
      caloriesKcal: calories(lap.caloriesKcal),
    })),
    samples: samples.slice(startIndex, endIndex).map((sample) => ({
      ...sample, distance: distance(sample.distance),
    })),
    summary: {
      startTimeMs: start.startMs,
      endTimeMs: end.startMs,
      totalElapsedSeconds: Math.max(timer, (end.startMs - start.startMs) / 1000),
      totalTimerSeconds: timer,
      totalDistanceMeters: distance(end.distanceMeters),
      totalCalories: calories(end.caloriesKcal),
    },
  };
}
