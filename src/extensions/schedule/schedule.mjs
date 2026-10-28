import {TASK_CONFIG as config} from './config.mjs';

const minuteMs = 60000;
const calendarSearchMinutes = 16 * 24 * 60;
const calendarLocale = 'en-GB';
const calendarFormat = {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};

export function validateEvent(value) {
  if (typeof value !== 'string' || !value.length || value.length > config.eventLength || !/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error(`Event name must be 1-${config.eventLength} characters: letters, digits, underscores, dots, colons or hyphens`);
  }
  return value;
}

export function calendarNext(rule, after) {
  const format = new Intl.DateTimeFormat(calendarLocale, {...calendarFormat, timeZone: rule.timeZone});
  const [hour, minute] = rule.time.split(':').map(Number);
  const local = stamp => Object.fromEntries(format.formatToParts(stamp).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const previous = local(after);
  for (let stamp = (Math.floor(after / minuteMs) + 1) * minuteMs, end = stamp + calendarSearchMinutes * minuteMs; stamp <= end; stamp += minuteMs) {
    const parts = local(stamp);
    if (parts.hour !== hour || parts.minute !== minute) continue;
    if (previous.hour === hour && previous.minute >= minute && parts.year === previous.year && parts.month === previous.month && parts.day === previous.day) continue;
    const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    if (rule.kind === 'daily' || rule.weekdays.includes(day)) return stamp;
  }
  throw new Error('Could not compute the next run time');
}

export function normalizeSchedule(input, now) {
  const kind = input.kind;
  if (!config.kinds.includes(kind)) throw new Error('Invalid trigger kind');
  const result = {kind, nextAt: null, everySeconds: null, event: null, time: null, timeZone: null, weekdays: []};
  if (kind === 'hook') {
    result.event = validateEvent(input.event);
    return result;
  }
  if (kind === 'daily' || kind === 'weekly') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || '')) throw new Error('Please enter a valid 24-hour time');
    if (typeof input.timeZone !== 'string' || !input.timeZone) throw new Error('Please select a time zone');
    try {
      new Intl.DateTimeFormat(calendarLocale, {timeZone: input.timeZone}).format(now);
    } catch {
      throw new Error('Invalid time zone; use an IANA name such as Asia/Shanghai');
    }
    Object.assign(result, {time: input.time, timeZone: input.timeZone});
    if (kind === 'weekly') {
      if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some(day => !Number.isInteger(day) || day < 0 || day >= 7)) throw new Error('Select at least one weekday; 0 is Sunday');
      result.weekdays = [...new Set(input.weekdays)].sort();
    }
    result.nextAt = calendarNext(result, now);
    return result;
  }
  if (typeof input.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at)) throw new Error('Run time must include a time zone');
  result.nextAt = Date.parse(input.at);
  if (!Number.isFinite(result.nextAt) || result.nextAt <= now) throw new Error('Run time must be later than now');
  if (kind === 'interval') {
    const everySeconds = input.everySeconds;
    if (!Number.isSafeInteger(everySeconds) || everySeconds < config.intervalMinSeconds || !Number.isSafeInteger(result.nextAt + everySeconds * config.secondMs)) {
      throw new Error('Repeat interval must be a valid positive integer number of seconds');
    }
    result.everySeconds = everySeconds;
  }
  return result;
}

export function advanceSchedule(task, now) {
  if (task.kind === 'once') return {completed: true};
  if (task.kind === 'interval') return {nextAt: now + task.everySeconds * config.secondMs};
  if (task.kind === 'daily' || task.kind === 'weekly') return {nextAt: calendarNext(task, now)};
  return {};
}
