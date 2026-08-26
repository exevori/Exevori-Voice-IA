const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const DAY_LABELS_FR = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
];

// ISO-8601: lundi=1 ... dimanche=7. La migration utilise ce format pour
// l'horaire sortant, tandis que l'API accepte aussi les noms anglais.
const ISO_DAY_KEYS = ["7", "1", "2", "3", "4", "5", "6"];

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class BusinessHoursConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = "BusinessHoursConfigurationError";
    this.code = code;
  }
}

function parseTime(value, { allowEndOfDay = false } = {}) {
  if (allowEndOfDay && value === "24:00") return 24 * 60;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const startText = value.start ?? value.open;
  const endText = value.end ?? value.close;
  const start = parseTime(startText);
  const end = parseTime(endText, { allowEndOfDay: true });
  if (start === null || end === null || start === end) return null;

  return { start, end };
}

/**
 * Normalise le JSON d'horaires. Chaque jour accepte soit une plage unique
 * `{ open, close }`, soit un tableau de plages `{ start, end }`. Les plages
 * qui traversent minuit sont prises en charge.
 */
export function normalizeBusinessHours(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessHoursConfigurationError("invalid_business_hours");
  }

  const normalized = {};
  for (let dayIndex = 0; dayIndex < DAY_NAMES.length; dayIndex += 1) {
    const dayName = DAY_NAMES[dayIndex];
    const namedValue = value[dayName];
    const isoValue = value[ISO_DAY_KEYS[dayIndex]];
    if (
      namedValue !== null && namedValue !== undefined
      && isoValue !== null && isoValue !== undefined
    ) {
      throw new BusinessHoursConfigurationError("ambiguous_business_hours");
    }
    const dayValue = namedValue ?? isoValue;
    if (dayValue === null || dayValue === undefined) {
      normalized[dayName] = [];
      continue;
    }

    const rawWindows = Array.isArray(dayValue) ? dayValue : [dayValue];
    if (rawWindows.length > 8) {
      throw new BusinessHoursConfigurationError("too_many_business_windows");
    }

    const windows = rawWindows.map(normalizeWindow);
    if (windows.some(window => window === null)) {
      throw new BusinessHoursConfigurationError("invalid_business_hours");
    }
    normalized[dayName] = windows.sort((left, right) => left.start - right.start);
  }

  return normalized;
}

function formatStoredTime(minutes) {
  if (minutes === 24 * 60) return "24:00";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Valide puis réduit un horaire à la forme persistée par VoiceDesk.
 * Les clés ISO évitent les écarts de langue et les propriétés inconnues sont
 * volontairement supprimées avant l'écriture en base.
 */
export function canonicalizeBusinessHours(value) {
  const normalized = normalizeBusinessHours(value);
  if (normalized === null) return null;

  const stored = {};
  for (let dayIndex = 0; dayIndex < DAY_NAMES.length; dayIndex += 1) {
    stored[ISO_DAY_KEYS[dayIndex]] = normalized[DAY_NAMES[dayIndex]].map(
      window => ({
        start: formatStoredTime(window.start),
        end: formatStoredTime(window.end),
      })
    );
  }
  return stored;
}

function localClock(date, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new BusinessHoursConfigurationError("invalid_business_timezone");
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  const dayIndex = DAY_NAMES.indexOf(String(parts.weekday || "").toLowerCase());
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (
    dayIndex < 0
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
  ) {
    throw new BusinessHoursConfigurationError("invalid_local_clock");
  }

  return { dayIndex, minuteOfDay: hour * 60 + minute };
}

function isInsideWindow(window, minuteOfDay, previousDay = false) {
  if (window.start < window.end) {
    return !previousDay
      && minuteOfDay >= window.start
      && minuteOfDay < window.end;
  }

  return previousDay
    ? minuteOfDay < window.end
    : minuteOfDay >= window.start;
}

function formatOpeningTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return minute === 0 ? `${hour} h` : `${hour} h ${String(minute).padStart(2, "0")}`;
}

function findNextOpening(schedule, dayIndex, minuteOfDay) {
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDay = (dayIndex + offset) % 7;
    const windows = schedule[DAY_NAMES[candidateDay]] || [];
    for (const window of windows) {
      if (offset === 0 && window.start <= minuteOfDay) continue;
      return {
        dayIndex: candidateDay,
        dayOffset: offset,
        start: window.start,
      };
    }
  }
  return null;
}

function formatNextOpening(nextOpening) {
  if (!nextOpening) return null;
  const time = formatOpeningTime(nextOpening.start);
  if (nextOpening.dayOffset === 0) return `aujourd'hui à ${time}`;
  if (nextOpening.dayOffset === 1) return `demain à ${time}`;
  return `${DAY_LABELS_FR[nextOpening.dayIndex]} à ${time}`;
}

/**
 * Évalue un instant absolu dans le fuseau IANA du client. Intl applique les
 * règles d'heure avancée/heure normale de la plateforme Node.
 */
export function evaluateBusinessHours({
  now = new Date(),
  timeZone,
  businessHours,
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw new BusinessHoursConfigurationError("invalid_business_instant");
  }

  const schedule = normalizeBusinessHours(businessHours);
  if (schedule === null) {
    return {
      configured: false,
      isOpen: true,
      nextOpen: null,
      nextOpenLabel: null,
    };
  }

  const { dayIndex, minuteOfDay } = localClock(instant, timeZone);
  const currentWindows = schedule[DAY_NAMES[dayIndex]] || [];
  const previousDayIndex = (dayIndex + 6) % 7;
  const previousWindows = schedule[DAY_NAMES[previousDayIndex]] || [];
  const isOpen =
    currentWindows.some(window => isInsideWindow(window, minuteOfDay))
    || previousWindows.some(window =>
      isInsideWindow(window, minuteOfDay, true)
    );

  const nextOpen = isOpen
    ? null
    : findNextOpening(schedule, dayIndex, minuteOfDay);

  return {
    configured: true,
    isOpen,
    localDay: DAY_NAMES[dayIndex],
    localMinute: minuteOfDay,
    nextOpen,
    nextOpenLabel: formatNextOpening(nextOpen),
  };
}
