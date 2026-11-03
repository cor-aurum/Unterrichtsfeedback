/** Ein Eintrag für den Systemkalender; Zeitpunkte als „YYYY-MM-DDTHH:MM“ in Ortszeit. */
export interface CalendarEvent {
  /** Bleibt bei jedem Export gleich, damit ein erneuter Import Termine aktualisiert statt sie zu verdoppeln */
  uid: string;
  start: string;
  end: string;
  summary: string;
  location?: string;
  description?: string;
}

/**
 * iCalendar-Datei (RFC 5545) für den Import in Kalender-Apps. Die Zeiten sind „floating“, also ohne Zeitzone:
 * Der Kalender zeigt sie so, wie sie in der App stehen, auch nach der Zeitumstellung.
 */
export function toICalendar(calendarName: string, events: CalendarEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unterrichtsfeedback//Kalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    ...events.flatMap((event) => eventLines(event, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function eventLines(event: CalendarEvent, stamp: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dateTime(event.start)}`,
    `DTEND:${dateTime(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    'END:VEVENT',
  ];
}

/** „2026-11-03T14:00“ → „20261103T140000“; „T24:00“ wird zu 0 Uhr am Folgetag. */
function dateTime(value: string): string {
  const [date, time] = value.split('T');
  if (time === '24:00') {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return `${next.toISOString().slice(0, 10).replace(/-/g, '')}T000000`;
  }
  return `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Zeilen über 75 Byte werden umbrochen; die Folgezeile beginnt mit einem Leerzeichen. Umlaute bleiben ganz. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
