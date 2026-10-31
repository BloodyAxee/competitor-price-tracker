export interface DailySchedule {
  minute: number;
  hour: number;
}

export interface ZonedDateParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
}

export function parseDailyCron(value: string): DailySchedule {
  const match = value.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!match) {
    throw new Error("COLLECTION_CRON must be a once-daily expression such as '0 3 * * *'");
  }
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) {
    throw new Error("COLLECTION_CRON contains an invalid hour or minute");
  }
  return { minute, hour };
}

export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function isDailyScheduleDue(parts: ZonedDateParts, schedule: DailySchedule): boolean {
  return parts.hour > schedule.hour || (parts.hour === schedule.hour && parts.minute >= schedule.minute);
}

export function dailyJobKey(parts: ZonedDateParts, timeZone: string): string {
  return `daily:${timeZone}:${parts.year}-${parts.month}-${parts.day}`;
}
