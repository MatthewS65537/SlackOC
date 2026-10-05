import { CronExpressionParser } from "cron-parser";

export interface ScheduleSpec {
  time: string;
  timezone: string;
  /** Sunday = 0; all seven days is a daily schedule. */
  days: number[];
}

export function validateSchedule(schedule: ScheduleSpec): void {
  if (!schedule || typeof schedule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
      typeof schedule.timezone !== "string" || !schedule.timezone || schedule.timezone.length > 128 ||
      /^[+-]/.test(schedule.timezone) || !Array.isArray(schedule.days) || !schedule.days.length ||
      schedule.days.length > 7 || new Set(schedule.days).size !== schedule.days.length ||
      [...schedule.days].some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Invalid schedule; use HH:mm, an explicit IANA time zone, and distinct weekdays (0–6)");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }); }
  catch { throw new Error("Invalid IANA schedule time zone"); }
}

function expression(schedule: ScheduleSpec): string {
  validateSchedule(schedule);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = schedule.days.length === 7 ? "*" : [...schedule.days].sort((a, b) => a - b).join(",");
  return `${minute} ${hour} * * ${days}`;
}

// Include the preceding weekly occurrence even when a DST gap skips a week.
// Only cron-parser interprets local dates and DST; this is an iteration window.
const LOOKBACK_MS = 16 * 24 * 60 * 60 * 1000;

function occurrences(schedule: ScheduleSpec, boundary: number) {
  if (!Number.isSafeInteger(boundary) || !Number.isFinite(new Date(boundary).getTime()) ||
      !Number.isFinite(new Date(boundary - LOOKBACK_MS).getTime())) throw new Error("Invalid recurrence boundary");
  return CronExpressionParser.parse(expression(schedule), { currentDate: boundary - LOOKBACK_MS, tz: schedule.timezone });
}

/** Strictly after `after`. Uses cron-parser's forward gap policy; folds use the first occurrence. */
export function nextOccurrence(schedule: ScheduleSpec, after: number): number {
  const iterator = occurrences(schedule, after);
  for (let i = 0; i < 32; i++) {
    const time = iterator.next().getTime();
    if (time > after) return time;
  }
  throw new Error("Unable to find the next schedule occurrence");
}

/** At or before `before`, using the same forward DST sequence as nextOccurrence. */
export function latestOccurrence(schedule: ScheduleSpec, before: number): number {
  const iterator = occurrences(schedule, before);
  let latest: number | undefined;
  // Direct prev() omits spring-gap occurrences and can pick the second fold.
  // Forward iteration also avoids seed-dependent duplicate fold occurrences.
  for (let i = 0; i < 32; i++) {
    const time = iterator.next().getTime();
    if (time > before) {
      if (latest === undefined) throw new Error("Unable to find the latest schedule occurrence");
      return latest;
    }
    latest = time;
  }
  throw new Error("Unable to find the latest schedule occurrence");
}
