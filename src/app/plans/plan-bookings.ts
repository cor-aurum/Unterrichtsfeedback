import { inject, Injectable } from '@angular/core';
import { CalendarStore } from '../calendar/calendar.store';
import { activeSelfBooking, ReportPeriodEntry, today } from '../model';
import { isOwnOneOff, PlanningScope, StudentPlanning } from '../planning/student-planning';
import { PlanBooking, ServerError, ServerLogin, serverApi } from '../sync/server-folder';
import { planServerId } from './plan-access';

/** Termin einer Eintragung über den Link; auf allen Geräten dieselbe ID, damit er nie doppelt entsteht. */
export function bookingAppointmentId(bookingId: string): string {
  return `buchung-${bookingId}`;
}

/**
 * Übernimmt die Eintragungen, die Personen auf der Download-Seite selbst gemacht haben (Selbsteintragung), in den
 * Kalender. Der Server hat die Zeiten schon der Reihe nach vergeben; die App prüft sie noch einmal gegen ihre Daten,
 * denn seit den letzten Plänen kann sich etwas geändert haben. Erst meldet sie dem Server, dass sie übernimmt, dann
 * ändert sie die Daten: So übernimmt nur ein Gerät, und eine inzwischen zurückgenommene Eintragung bleibt draußen.
 */
@Injectable({ providedIn: 'root' })
export class PlanBookings {
  private readonly planning = inject(StudentPlanning);
  private readonly calendar = inject(CalendarStore);

  /** Ohne Link (oder bei einem älteren Server) gibt es nichts zu übernehmen. */
  async apply(login: ServerLogin, period: ReportPeriodEntry): Promise<void> {
    const serverId = planServerId(period, login);
    let bookings: PlanBooking[];
    try {
      bookings = await serverApi.planBookings(login, serverId);
    } catch (e) {
      if (e instanceof ServerError && [404, 405].includes(e.status)) return;
      throw e;
    }
    for (const booking of bookings) {
      const problem = this.problem(booking, period);
      if (problem) {
        await serverApi.planBookingDone(login, serverId, booking.id, 'failed', problem);
      } else if (await serverApi.planBookingDone(login, serverId, booking.id, 'applied')) {
        this.perform(booking, period);
      }
    }
  }

  /** `null`, wenn die Eintragung geht, sonst der Grund für die Seite der Person */
  private problem(booking: PlanBooking, period: ReportPeriodEntry): string | null {
    if (booking.kind === 'cancel') return this.cancelProblem(booking);
    if (booking.kind !== 'book') return 'Unbekannte Eintragung.';
    if (this.exists(bookingAppointmentId(booking.id))) return null;
    const scope = scopeOf(period);
    if (!scope) return 'Die Selbsteintragung ist beendet.';
    return this.planning.bookingProblem(scope, booking.person, booking.teacher, slotOf(booking));
  }

  private cancelProblem(booking: PlanBooking): string | null {
    const appointment = this.calendar.appointments().find((a) => a.id === booking.slot);
    if (!appointment) return null;
    const own = appointment.studentId === booking.person && isOwnOneOff(appointment) && appointment.date >= today();
    return own ? null : 'Diesen Termin kann nur deine Lehrkraft austragen.';
  }

  private perform(booking: PlanBooking, period: ReportPeriodEntry): void {
    if (booking.kind === 'cancel') {
      if (this.exists(booking.slot)) this.calendar.remove(booking.slot);
      return;
    }
    const id = bookingAppointmentId(booking.id);
    const scope = scopeOf(period);
    if (scope && !this.exists(id)) this.planning.enterBooking(scope, booking.person, booking.teacher, slotOf(booking), id);
  }

  private exists(appointmentId: string): boolean {
    return this.calendar.appointments().some((a) => a.id === appointmentId);
  }
}

function scopeOf(period: ReportPeriodEntry): PlanningScope | null {
  const booking = activeSelfBooking(period);
  return booking ? { ...booking, periodId: period.id } : null;
}

function slotOf(booking: PlanBooking) {
  return { date: booking.date, start: booking.time, durationMinutes: booking.minutes };
}
