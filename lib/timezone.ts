import { format, toZonedTime, fromZonedTime } from 'date-fns-tz';
import { parse as dateFnsParse, parseISO } from 'date-fns';

/**
 * Australian timezones - Primary focus for this application
 * Listed first for easy access
 */
export const TIMEZONES = [
  // ─── AUSTRALIA ───
  { value: 'Australia/Sydney', label: '🇦🇺 Sydney (NSW) - AEST/AEDT' },
  { value: 'Australia/Melbourne', label: '🇦🇺 Melbourne (VIC) - AEST/AEDT' },
  { value: 'Australia/Brisbane', label: '🇦🇺 Brisbane (QLD) - AEST' },
  { value: 'Australia/Perth', label: '🇦🇺 Perth (WA) - AWST' },
  { value: 'Australia/Adelaide', label: '🇦🇺 Adelaide (SA) - ACST/ACDT' },
  { value: 'Australia/Darwin', label: '🇦🇺 Darwin (NT) - ACST' },
  { value: 'Australia/Hobart', label: '🇦🇺 Hobart (TAS) - AEST/AEDT' },
  { value: 'Australia/Canberra', label: '🇦🇺 Canberra (ACT) - AEST/AEDT' },
  { value: 'Australia/Lord_Howe', label: '🇦🇺 Lord Howe Island - LHST/LHDT' },
  { value: 'Australia/Broken_Hill', label: '🇦🇺 Broken Hill (NSW) - ACST/ACDT' },
  // ─── OTHER COUNTRIES ───
  { value: 'Pacific/Auckland', label: '🇳🇿 Auckland (New Zealand)' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Tokyo', label: 'Tokyo (Japan)' },
  { value: 'Asia/Colombo', label: 'Colombo (Sri Lanka)' },
  { value: 'Asia/Dubai', label: 'Dubai (UAE)' },
  { value: 'Europe/London', label: 'London (UK)' },
  { value: 'America/New_York', label: 'New York (US Eastern)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (US Pacific)' },
];

/**
 * Convert a local date and time in a specific timezone to UTC ISO string
 * This is used when storing booking times to the database
 * 
 * @param date - Date string in YYYY-MM-DD format
 * @param time - Time string in HH:mm format
 * @param timezone - IANA timezone string (e.g., 'Australia/Sydney')
 * @returns ISO string in UTC
 */
export function localToUTC(date: string, time: string, timezone: string): string {
  try {
    // Combine date and time into a local datetime string
    const localDateTimeString = `${date} ${time}`;
    
    // Parse the local datetime string (this creates a Date in the system's local timezone)
    const localDate = dateFnsParse(localDateTimeString, 'yyyy-MM-dd HH:mm', new Date());
    
    // Convert from the branch's timezone to UTC
    const utcDate = fromZonedTime(localDate, timezone);
    
    return utcDate.toISOString();
  } catch (error) {
    console.error('Error converting local time to UTC:', error);
    // Fallback: return a date object as ISO string
    return new Date(`${date}T${time}:00`).toISOString();
  }
}

/**
 * Convert a UTC ISO string to local date and time in a specific timezone
 * This is used when displaying booking times to users
 * 
 * @param utcIsoString - ISO string in UTC (e.g., '2024-12-18T10:00:00.000Z')
 * @param timezone - IANA timezone string (e.g., 'Australia/Sydney')
 * @returns Object with date (YYYY-MM-DD) and time (HH:mm)
 */
export function utcToLocal(utcIsoString: string, timezone: string): { date: string; time: string; dateTime: Date } {
  try {
    // Parse the UTC ISO string
    const utcDate = parseISO(utcIsoString);
    
    // Convert to the branch's timezone
    const localDate = toZonedTime(utcDate, timezone);
    
    // Format date and time
    const date = format(localDate, 'yyyy-MM-dd', { timeZone: timezone });
    const time = format(localDate, 'HH:mm', { timeZone: timezone });
    
    return { date, time, dateTime: localDate };
  } catch (error) {
    console.error('Error converting UTC to local time:', error);
    // Fallback: use the ISO string as-is
    const fallbackDate = new Date(utcIsoString);
    return {
      date: format(fallbackDate, 'yyyy-MM-dd'),
      time: format(fallbackDate, 'HH:mm'),
      dateTime: fallbackDate,
    };
  }
}

/**
 * Format a UTC ISO string for display in a specific timezone
 * 
 * @param utcIsoString - ISO string in UTC
 * @param timezone - IANA timezone string
 * @param formatString - date-fns format string (default: 'PPpp' - full date and time)
 * @returns Formatted string
 */
export function formatInTimezone(
  utcIsoString: string,
  timezone: string,
  formatString: string = 'PPpp'
): string {
  try {
    const utcDate = parseISO(utcIsoString);
    const localDate = toZonedTime(utcDate, timezone);
    return format(localDate, formatString, { timeZone: timezone });
  } catch (error) {
    console.error('Error formatting date in timezone:', error);
    return utcIsoString;
  }
}

/**
 * Get current date and time in a specific timezone
 * 
 * @param timezone - IANA timezone string
 * @returns Object with date (YYYY-MM-DD) and time (HH:mm)
 */
export function getCurrentDateTimeInTimezone(timezone: string): { date: string; time: string; dateTime: Date } {
  try {
    const now = new Date();
    const localDate = toZonedTime(now, timezone);
    
    const date = format(localDate, 'yyyy-MM-dd', { timeZone: timezone });
    const time = format(localDate, 'HH:mm', { timeZone: timezone });
    
    return { date, time, dateTime: localDate };
  } catch (error) {
    console.error('Error getting current time in timezone:', error);
    const now = new Date();
    return {
      date: format(now, 'yyyy-MM-dd'),
      time: format(now, 'HH:mm'),
      dateTime: now,
    };
  }
}

/**
 * Check if a datetime in a timezone falls within business hours
 * 
 * @param date - Date string in YYYY-MM-DD format
 * @param time - Time string in HH:mm format
 * @param timezone - IANA timezone string
 * @param businessHours - Business hours object with open and close times
 * @returns Boolean indicating if the time is within business hours
 */
export function isWithinBusinessHours(
  date: string,
  time: string,
  timezone: string,
  businessHours: { open: string; close: string; closed?: boolean }
): boolean {
  if (businessHours.closed) return false;
  
  try {
    const localDateTimeString = `${date} ${time}`;
    const localDate = dateFnsParse(localDateTimeString, 'yyyy-MM-dd HH:mm', new Date());
    const timeString = format(localDate, 'HH:mm');
    
    return timeString >= businessHours.open && timeString <= businessHours.close;
  } catch (error) {
    console.error('Error checking business hours:', error);
    return false;
  }
}

/**
 * Generate time slots for a given date in a specific timezone
 * 
 * @param date - Date string in YYYY-MM-DD format
 * @param timezone - IANA timezone string
 * @param businessHours - Business hours with open and close times
 * @param slotDurationMinutes - Duration of each slot in minutes (default: 30)
 * @returns Array of time slot objects
 */
export function generateTimeSlots(
  date: string,
  timezone: string,
  businessHours: { open: string; close: string; closed?: boolean },
  slotDurationMinutes: number = 30
): Array<{ time: string; label: string; utcIso: string }> {
  if (businessHours.closed) return [];
  
  const slots: Array<{ time: string; label: string; utcIso: string }> = [];
  
  try {
    // Parse open and close times
    const openTime = dateFnsParse(`${date} ${businessHours.open}`, 'yyyy-MM-dd HH:mm', new Date());
    const closeTime = dateFnsParse(`${date} ${businessHours.close}`, 'yyyy-MM-dd HH:mm', new Date());
    
    let currentTime = openTime;
    
    while (currentTime < closeTime) {
      const timeString = format(currentTime, 'HH:mm');
      const label = format(currentTime, 'h:mm a'); // 12-hour format with AM/PM
      
      // Convert to UTC for storage
      const utcIso = localToUTC(date, timeString, timezone);
      
      slots.push({ time: timeString, label, utcIso });
      
      // Move to next slot
      currentTime = new Date(currentTime.getTime() + slotDurationMinutes * 60 * 1000);
    }
  } catch (error) {
    console.error('Error generating time slots:', error);
  }
  
  return slots;
}

/**
 * Calculate the duration between two times in minutes
 * 
 * @param startTime - Start time in HH:mm format
 * @param endTime - End time in HH:mm format
 * @returns Duration in minutes
 */
export function calculateDuration(startTime: string, endTime: string): number {
  try {
    const baseDate = '2024-01-01';
    const start = dateFnsParse(`${baseDate} ${startTime}`, 'yyyy-MM-dd HH:mm', new Date());
    const end = dateFnsParse(`${baseDate} ${endTime}`, 'yyyy-MM-dd HH:mm', new Date());
    
    const diffMs = end.getTime() - start.getTime();
    return Math.floor(diffMs / (1000 * 60));
  } catch (error) {
    console.error('Error calculating duration:', error);
    return 0;
  }
}

/**
 * Validate if a timezone string is valid
 * 
 * @param timezone - IANA timezone string to validate
 * @returns Boolean indicating if timezone is valid
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get timezone offset in hours for display purposes
 * 
 * @param timezone - IANA timezone string
 * @returns Offset string (e.g., 'UTC+5:30')
 */
export function getTimezoneOffset(timezone: string): string {
  try {
    const now = new Date();
    const zonedTime = toZonedTime(now, timezone);
    const offsetMinutes = zonedTime.getTimezoneOffset();
    const offsetHours = Math.abs(Math.floor(offsetMinutes / 60));
    const offsetMins = Math.abs(offsetMinutes % 60);
    const sign = offsetMinutes <= 0 ? '+' : '-';
    
    if (offsetMins === 0) {
      return `UTC${sign}${offsetHours}`;
    }
    return `UTC${sign}${offsetHours}:${offsetMins.toString().padStart(2, '0')}`;
  } catch (error) {
    console.error('Error getting timezone offset:', error);
    return 'UTC';
  }
}

/**
 * Convert Firestore Timestamp to local date/time in a specific timezone
 * 
 * @param timestamp - Firestore Timestamp object
 * @param timezone - IANA timezone string
 * @returns Object with date and time in local timezone
 */
export function firestoreTimestampToLocal(
  timestamp: any,
  timezone: string
): { date: string; time: string; dateTime: Date } {
  try {
    // Handle Firestore Timestamp
    let date: Date;
    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (timestamp && timestamp.seconds) {
      date = new Date(timestamp.seconds * 1000);
    } else if (typeof timestamp === 'string') {
      date = parseISO(timestamp);
    } else {
      date = new Date(timestamp);
    }
    
    return utcToLocal(date.toISOString(), timezone);
  } catch (error) {
    console.error('Error converting Firestore timestamp:', error);
    const now = new Date();
    return {
      date: format(now, 'yyyy-MM-dd'),
      time: format(now, 'HH:mm'),
      dateTime: now,
    };
  }
}

/**
 * Compare if two datetime values represent the same moment in time
 * accounting for different timezones
 * 
 * @param date1 - First date
 * @param time1 - First time
 * @param timezone1 - First timezone
 * @param date2 - Second date
 * @param time2 - Second time
 * @param timezone2 - Second timezone
 * @returns Boolean indicating if they represent the same moment
 */
export function areSameDateTime(
  date1: string,
  time1: string,
  timezone1: string,
  date2: string,
  time2: string,
  timezone2: string
): boolean {
  try {
    const utc1 = localToUTC(date1, time1, timezone1);
    const utc2 = localToUTC(date2, time2, timezone2);
    return utc1 === utc2;
  } catch (error) {
    console.error('Error comparing datetimes:', error);
    return false;
  }
}
