export const ROUNDING_SECONDS = 360;

/**
 * Round a duration (in seconds) to the nearest multiple of {@link ROUNDING_SECONDS}.
 *
 * Intervals rejects time entries whose decimal-hour representation is too long
 * (error "Time is too precise."). All known-accepted values fall on 6-minute
 * boundaries, so we snap every persisted duration to the nearest 6 minutes.
 *
 * Round-half-up on ties so borderline durations bill up rather than down.
 */
export function roundDurationSecondsForIntervals(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.floor(durationSeconds / ROUNDING_SECONDS + 0.5) * ROUNDING_SECONDS;
}
