const MAX_TIMEZONE_LENGTH = 64;

export function isValidIanaTimezone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > MAX_TIMEZONE_LENGTH) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
