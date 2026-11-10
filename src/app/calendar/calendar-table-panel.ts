import { Component, computed, inject, signal } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { locationOn } from '../model';
import { ReportPeriod } from '../report-period';
import { isNativeApp, saveFile } from '../save-file';
import { storedSignal } from '../stored-signal';
import { Appointment, daysBetween, endTime, minutesOf, Occurrence } from './appointments';
import { blockerOnDay } from './blockers';
import { CalendarStore } from './calendar.store';
import { CalendarRow, CalendarRowKind, sortRows, toCsv } from './calendar-table';
import { sharedEndTime } from './shared-appointments';

/** Längster Zeitraum, wie beim iCal-Export */
const MAX_DAYS = 2 * 366;

const KINDS: { kind: CalendarRowKind; label: string }[] = [
  { kind: 'Einzelunterricht', label: 'Einzelunterricht' },
  { kind: 'Gruppe', label: 'Gruppentermine' },
  { kind: 'Allgemein', label: 'Allgemeine Termine' },
  { kind: 'Blocker', label: 'Blocker' },
];

/**
 * Alle Termine eines Zeitraums als Tabelle (CSV, öffnet sich in Excel), eine Zeile je Termin und Tag. Die Spalten
 * passen zum Import allgemeiner Termine; er übernimmt aus einer solchen Datei nur die Zeilen der Art „Allgemein“.
 */
@Component({
  selector: 'app-calendar-table-panel',
  templateUrl: './calendar-table-panel.html',
  styleUrl: './ical-export-panel.scss',
})
export class CalendarTablePanel {
  private readonly activeTeacher = inject(ActiveTeacher);
  private readonly calendar = inject(CalendarStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly nativeApp = isNativeApp;
  protected readonly kinds = KINDS;

  /** Anfangs der Berichtszeitraum */
  protected readonly from = signal(this.reportPeriod.period().from);
  protected readonly to = signal(this.reportPeriod.period().to);
  /** Gewählte Arten; gilt nur auf diesem Gerät. */
  protected readonly selectedKinds = storedSignal<CalendarRowKind[]>(
    'feedback.tableKinds',
    () => ['Einzelunterricht', 'Gruppe', 'Allgemein'],
    (data) => (Array.isArray(data) ? data.filter((k) => KINDS.some((entry) => entry.kind === k)) : []),
  );
  protected readonly message = signal<string | null>(null);
  protected readonly canExport = computed(() => this.selectedKinds().length > 0);

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected toggleKind(kind: CalendarRowKind): void {
    this.selectedKinds.update((kinds) => (kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]));
  }

  protected async export(): Promise<void> {
    const [from, to] = [this.from(), this.to()];
    if (!from || !to || from > to) {
      this.message.set('Bitte einen gültigen Zeitraum wählen („von“ vor „bis“).');
      return;
    }
    if (daysBetween(from, to).length > MAX_DAYS) {
      this.message.set('Der Zeitraum darf höchstens zwei Jahre lang sein.');
      return;
    }
    const rows = sortRows(this.rowsOf(from, to));
    this.message.set(rows.length === 0 ? 'Im Zeitraum gibt es keine Termine der gewählten Arten.' : null);
    if (rows.length === 0) return;
    const file = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    await saveFile(`Termine_${from}_${to}.csv`, file);
  }

  private rowsOf(from: string, to: string): CalendarRow[] {
    const kinds = new Set(this.selectedKinds());
    return [
      ...this.calendar
        .occurrences(from, to)
        .filter(({ appointment }) => kinds.has(appointment.groupId ? 'Gruppe' : 'Einzelunterricht'))
        .map((occurrence) => this.appointmentRow(occurrence)),
      ...(kinds.has('Allgemein') ? this.sharedRows(from, to) : []),
      ...(kinds.has('Blocker') ? this.blockerRows(from, to) : []),
    ];
  }

  /** Einzel- und Gruppenunterricht stehen im Raum des Lehrers, in dessen Kalender sie stehen, an diesem Tag. */
  private appointmentRow({ date, appointment }: Occurrence): CalendarRow {
    const teacher = this.groupsStore.calendarTeacherOf(appointment);
    return {
      kind: appointment.groupId ? 'Gruppe' : 'Einzelunterricht',
      title: this.groupsStore.ownerNames().get(ownerId(appointment)) ?? '',
      date,
      start: appointment.start,
      end: endTime(appointment),
      durationMinutes: appointment.durationMinutes,
      location: this.groupsStore.appointmentLocation(appointment, date),
      teachers: [teacher.name],
    };
  }

  private sharedRows(from: string, to: string): CalendarRow[] {
    const teachers = this.config().teachers;
    return this.calendar.sharedOccurrences(from, to).map(({ date, appointment }) => ({
      kind: 'Allgemein',
      title: appointment.title,
      date,
      start: appointment.start,
      end: sharedEndTime(appointment),
      durationMinutes: appointment.durationMinutes,
      location: appointment.location,
      teachers: teachers.filter((t) => appointment.teacherIds.includes(t.id)).map((t) => t.name),
    }));
  }

  /** Mehrtägige Blocker stehen an jedem Tag einzeln, mit ihrem Teil des Tages. */
  private blockerRows(from: string, to: string): CalendarRow[] {
    const label = this.config().calendarPdf.blocked;
    return this.activeTeacher.visibleTeachers().flatMap((teacher) =>
      this.calendar.blockersOf(teacher.id, from, to).flatMap((blocker) =>
        daysBetween(from, to).flatMap((date) => {
          const part = blockerOnDay(blocker, date);
          if (!part) return [];
          return [
            {
              kind: 'Blocker' as const,
              title: blocker.title ? `${label}: ${blocker.title}` : label,
              date,
              start: part.start,
              end: part.end,
              durationMinutes: minutesOf(part.end) - minutesOf(part.start),
              location: locationOn(teacher, this.config(), date),
              teachers: [teacher.name],
            },
          ];
        }),
      ),
    );
  }
}

function ownerId(appointment: Appointment): string {
  return appointment.studentId ?? appointment.groupId ?? '';
}
