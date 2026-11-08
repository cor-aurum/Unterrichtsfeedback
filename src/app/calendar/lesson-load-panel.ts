import { Component, computed, inject, signal } from '@angular/core';
import { StudentLabelPipe } from '../student-label.pipe';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { formatDate, today } from '../model';
import { ReportPeriod } from '../report-period';
import { storedSignal } from '../stored-signal';
import { StudentsStore } from '../students.store';
import { addDays, mondayOf } from './appointments';
import { CalendarStore } from './calendar.store';
import { formatMinutes, LessonLoad, lessonLoads, totalMinutes } from './lesson-load';

type Preset = 'week' | 'month' | 'report';

/**
 * Übersicht im Kalender: wie viel Unterricht jede Person im Zeitraum geplant hat, als Balken nach Dauer
 * sortiert. So fällt schnell auf, wer mehr oder weniger Unterricht hat als die anderen.
 */
@Component({
  selector: 'app-lesson-load-panel',
  imports: [StudentLabelPipe],
  templateUrl: './lesson-load-panel.html',
  styleUrl: './lesson-load-panel.scss',
})
export class LessonLoadPanel {
  private readonly calendar = inject(CalendarStore);
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly config = inject(ConfigStore).config;
  private readonly reportPeriod = inject(ReportPeriod);
  protected readonly activeTeacher = inject(ActiveTeacher);
  protected readonly formatMinutes = formatMinutes;
  protected readonly totalMinutes = totalMinutes;
  protected readonly formatDate = formatDate;

  protected readonly from = signal(this.reportPeriod.period().from);
  protected readonly to = signal(this.reportPeriod.period().to);
  /** Nur die Personen des aktiven Lehrers oder alle; gilt nur auf diesem Gerät. */
  protected readonly allTeachers = storedSignal<boolean>('feedback.loadAllTeachers', () => false, (data) => data === true);
  protected readonly multipleTeachers = computed(() => this.activeTeacher.visibleTeachers().length > 1);

  protected readonly loads = computed(() => {
    const [from, to] = [this.from(), this.to()];
    if (!from || !to || from > to) return [];
    const students = this.studentsStore
      .students()
      .filter((student) => this.allTeachers() || this.activeTeacher.teaches(student));
    return lessonLoads(students, this.groupsStore.groups(), this.calendar.occurrences(from, to));
  });
  private readonly maxMinutes = computed(() => Math.max(1, ...this.loads().map(totalMinutes)));
  protected readonly averageMinutes = computed(() => {
    const loads = this.loads();
    return loads.length ? Math.round(loads.reduce((sum, load) => sum + totalMinutes(load), 0) / loads.length) : 0;
  });
  /** Position der Durchschnittslinie in Prozent der Balkenbreite */
  protected readonly averagePercent = computed(() => (this.averageMinutes() / this.maxMinutes()) * 100);

  protected setPreset(preset: Preset): void {
    const date = today();
    if (preset === 'week') {
      this.from.set(mondayOf(date));
      this.to.set(addDays(mondayOf(date), 6));
    } else if (preset === 'month') {
      const first = `${date.slice(0, 8)}01`;
      const nextMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1));
      this.from.set(first);
      this.to.set(addDays(nextMonth.toISOString().slice(0, 10), -1));
    } else {
      this.from.set(this.reportPeriod.period().from);
      this.to.set(this.reportPeriod.period().to);
    }
  }

  protected setDate(key: 'from' | 'to', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (value) this[key].set(value);
  }

  protected percent(minutes: number): number {
    return (minutes / this.maxMinutes()) * 100;
  }

  protected teacherName(load: LessonLoad): string {
    return this.studentsStore.teacherOf(load.student).name;
  }

  /** z. B. „12 Termine (3 in Gruppen)“ */
  protected countText(load: LessonLoad): string {
    const count = load.individualCount + load.groupCount;
    const total = count === 1 ? '1 Termin' : `${count} Termine`;
    return load.groupCount > 0 ? `${total} (${load.groupCount} in Gruppen)` : total;
  }
}
