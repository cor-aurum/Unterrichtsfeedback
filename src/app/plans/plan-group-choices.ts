import { inject, Injectable } from '@angular/core';
import { GroupChoice } from '../groups/group-choice';
import { ReportPeriodEntry } from '../model';
import { PlanGroupChoice, ServerError, ServerLogin, serverApi } from '../sync/server-folder';
import { planServerId } from './plan-access';

/**
 * Übernimmt die Gruppen, die Personen auf ihrer Seite des Download-Links gewählt haben. Die ältesten zuerst, damit
 * am Ende die neueste Wahl gilt; das Übernehmen setzt den Zielzustand und darf deshalb auch doppelt geschehen.
 */
@Injectable({ providedIn: 'root' })
export class PlanGroupChoices {
  private readonly choice = inject(GroupChoice);

  /** Ohne Link (oder bei einem älteren Server) gibt es nichts zu übernehmen. */
  async apply(login: ServerLogin, period: ReportPeriodEntry): Promise<void> {
    const serverId = planServerId(period, login);
    let choices: PlanGroupChoice[];
    try {
      choices = await serverApi.planGroupChoices(login, serverId);
    } catch (e) {
      if (e instanceof ServerError && [404, 405].includes(e.status)) return;
      throw e;
    }
    for (const choice of choices) {
      const ok = this.choice.choose(choice.person, choice.group, period.id);
      await serverApi.planGroupChoiceDone(login, serverId, choice.id, ok ? 'applied' : 'failed', ok ? '' : 'Diese Gruppe steht nicht mehr zur Wahl.');
    }
  }
}
