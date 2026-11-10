import { inject, Injectable } from '@angular/core';
import { Appointment } from '../calendar/appointments';
import { CalendarStore } from '../calendar/calendar.store';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { ReportPeriodEntry, Student, Teacher, teacherOf } from '../model';
import { StudentsStore } from '../students.store';
import { AcceptedPlanRequest, ServerError, ServerLogin, serverApi } from '../sync/server-folder';
import { planServerId } from './plan-access';
import { isOpenSingle, spontaneousGroupId } from './plan-slots';

const CHANGED = 'Der Termin hat sich inzwischen geändert.';

/**
 * Übernimmt Anfragen, die zwei Personen auf der Download-Seite vereinbart haben, in die Daten: Termine tauschen oder
 * gemeinsam haben. Jede App einer Lehrkraft des Zeitraums tut das beim Abgleich; das Ergebnis hängt nicht davon ab,
 * wie oft oder auf wie vielen Geräten es geschieht, denn es setzt den Zielzustand statt umzuschalten.
 */
@Injectable({ providedIn: 'root' })
export class PlanRequests {
  private readonly config = inject(ConfigStore).config;
  private readonly studentsStore = inject(StudentsStore);
  private readonly groupsStore = inject(GroupsStore);
  private readonly calendar = inject(CalendarStore);

  /** Ohne Link (oder bei einem älteren Server) gibt es nichts zu übernehmen. */
  async apply(login: ServerLogin, period: ReportPeriodEntry): Promise<void> {
    let requests: AcceptedPlanRequest[];
    try {
      requests = await serverApi.planRequests(login, planServerId(period, login));
    } catch (e) {
      if (e instanceof ServerError && [404, 405].includes(e.status)) return;
      throw e;
    }
    for (const request of requests) {
      const problem = this.applyOne(request, period);
      await serverApi.planRequestDone(login, planServerId(period, login), request.id, problem ? 'failed' : 'applied', problem ?? '');
    }
  }

  /** `null`, wenn die Anfrage jetzt in den Daten steht, sonst der Grund für die Download-Seite */
  private applyOne(request: AcceptedPlanRequest, period: ReportPeriodEntry): string | null {
    const from = this.student(request.from);
    const to = this.student(request.to);
    if (!from || !to) return 'Eine der Personen gibt es nicht mehr.';
    if (request.kind === 'swap') return this.swap(request, from, to, period);
    if (request.kind === 'join') return this.join(request, from, to, period);
    return 'Unbekannte Anfrage.';
  }

  /** Beide Termine wechseln die Person; die Lehrkraft bleibt dieselbe. */
  private swap(request: AcceptedPlanRequest, from: Student, to: Student, period: ReportPeriodEntry): string | null {
    const mine = this.appointment(request.fromSlot);
    const theirs = this.appointment(request.toSlot);
    if (!mine || !theirs) return 'Einen der Termine gibt es nicht mehr.';
    if (mine.studentId === to.id && theirs.studentId === from.id) return null;
    if (mine.studentId !== from.id || theirs.studentId !== to.id || !isOpenSingle(mine) || !isOpenSingle(theirs)) {
      return CHANGED;
    }
    const teacher = this.groupsStore.calendarTeacherOf(mine);
    if (teacher.id !== this.groupsStore.calendarTeacherOf(theirs).id) {
      return 'Die Termine sind bei verschiedenen Lehrkräften.';
    }
    this.calendar.update(mine.id, this.assignedTo(mine, to, teacher, period));
    this.calendar.update(theirs.id, this.assignedTo(theirs, from, teacher, period));
    return null;
  }

  /**
   * Termin für eine andere Person; hat sie eine andere Lehrkraft, bleibt er als Ausnahme bei dieser. Der Zeitraum des
   * Termins bleibt und wird festgeschrieben.
   */
  private assignedTo(appointment: Appointment, student: Student, teacher: Teacher, period: ReportPeriodEntry): Omit<Appointment, 'id'> {
    const { id: _id, teacherId: _teacher, studentId: _student, ...rest } = appointment;
    const periodId = this.groupsStore.appointmentPeriodId(appointment) ?? period.id;
    const own = teacherOf(student, this.config(), periodId).id === teacher.id;
    return { ...rest, studentId: student.id, periodId, ...(own ? {} : { teacherId: teacher.id }) };
  }

  /**
   * `from` kommt zum Unterricht von `to` dazu: Der Einzeltermin wird zum Termin einer spontanen Gruppe bei derselben
   * Lehrkraft. Ist er das schon, kommt `from` in die Gruppe.
   */
  private join(request: AcceptedPlanRequest, from: Student, to: Student, period: ReportPeriodEntry): string | null {
    const target = this.appointment(request.toSlot);
    if (!target) return 'Den Termin gibt es nicht mehr.';
    const groupId = spontaneousGroupId(target.id);
    if (target.groupId === groupId) {
      const group = this.groupsStore.allGroups().find((g) => g.id === groupId);
      if (!group || !group.memberIds.includes(to.id)) return CHANGED;
      this.groupsStore.addMembers(groupId, [from.id]);
      return null;
    }
    if (target.studentId !== to.id || !isOpenSingle(target)) return CHANGED;
    const teacher = this.groupsStore.calendarTeacherOf(target);
    const periodId = this.groupsStore.appointmentPeriodId(target) ?? period.id;
    this.groupsStore.allGroups.update((groups) => [
      ...groups.filter((g) => g.id !== groupId),
      { id: groupId, name: '', memberIds: [to.id, from.id], teacherId: teacher.id, periodId, lessons: [], generalTexts: {} },
    ]);
    const { id: _id, studentId: _student, teacherId: _teacher, ...rest } = target;
    this.calendar.update(target.id, { ...rest, groupId });
    return null;
  }

  private appointment(id: string): Appointment | undefined {
    return this.calendar.appointments().find((a) => a.id === id);
  }

  private student(id: string): Student | undefined {
    return this.studentsStore.allStudents().find((s) => s.id === id);
  }
}
