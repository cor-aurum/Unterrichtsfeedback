import { Component, computed, input } from '@angular/core';
import { Student } from '../model';
import { ageOn, ageStats, formatAge } from './age-groups';

export interface ChartGroup {
  name: string;
  members: Student[];
}

/** Breite der Beschriftung links und der Zeichenfläche im SVG-Koordinatensystem */
const LABEL_WIDTH = 150;
const PLOT_WIDTH = 450;
const ROW_HEIGHT = 44;
const AXIS_HEIGHT = 28;

/**
 * Altersverteilung mehrerer Gruppen auf einer gemeinsamen Achse: je Gruppe eine Zeile mit einem Punkt je Person,
 * dem Bereich vom jüngsten bis zum ältesten Mitglied und dem Durchschnitt als Raute. Personen ohne Geburtsdatum
 * zählen nur in der Beschriftung mit.
 */
@Component({
  selector: 'app-age-chart',
  templateUrl: './age-chart.html',
  styleUrl: './age-chart.scss',
})
export class AgeChart {
  readonly groups = input.required<ChartGroup[]>();
  /** Stichtag für das Alter */
  readonly date = input.required<string>();

  protected readonly labelWidth = LABEL_WIDTH;
  protected readonly width = LABEL_WIDTH + PLOT_WIDTH + 20;
  protected readonly formatAge = formatAge;

  /** Ganze Jahre links und rechts aller Punkte */
  private readonly range = computed(() => {
    const ages = this.groups()
      .flatMap((group) => group.members.map((m) => ageOn(m, this.date())))
      .filter((age) => age !== null);
    if (ages.length === 0) return null;
    const min = Math.floor(Math.min(...ages));
    const max = Math.ceil(Math.max(...ages));
    return { min, max: max === min ? min + 1 : max };
  });

  protected readonly height = computed(() => AXIS_HEIGHT + this.groups().length * ROW_HEIGHT + 8);

  /** Achsenbeschriftung: etwa sechs Striche, auf ganze Jahre gerundet */
  protected readonly ticks = computed(() => {
    const range = this.range();
    if (!range) return [];
    const step = Math.max(1, Math.ceil((range.max - range.min) / 6));
    const ticks: { x: number; label: string }[] = [];
    for (let age = range.min; age <= range.max; age += step) ticks.push({ x: this.x(age), label: String(age) });
    return ticks;
  });

  protected readonly rows = computed(() =>
    this.groups().map((group, index) => {
      const y = AXIS_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
      const stats = ageStats(group.members, this.date());
      const dots = group.members
        .map((member) => ({ member, age: ageOn(member, this.date()) }))
        .filter((entry) => entry.age !== null)
        .sort((a, b) => a.age! - b.age!)
        // Gleich alte Personen leicht versetzt, damit sie sich nicht verdecken
        .map((entry, i) => ({ ...entry, x: this.x(entry.age!), y: y + (i % 2 === 0 ? -4 : 4) }));
      return {
        name: group.name,
        y,
        stats,
        dots,
        line: stats.min === null ? null : { from: this.x(stats.min), to: this.x(stats.max!) },
        meanX: stats.mean === null ? null : this.x(stats.mean),
      };
    }),
  );

  protected readonly hasAges = computed(() => this.range() !== null);

  private x(age: number): number {
    const range = this.range()!;
    return LABEL_WIDTH + ((age - range.min) / (range.max - range.min)) * PLOT_WIDTH;
  }

  /** Raute um den Durchschnitt */
  protected diamond(x: number, y: number): string {
    return `${x},${y - 7} ${x + 6},${y} ${x},${y + 7} ${x - 6},${y}`;
  }

  protected rowLabel(row: { name: string; stats: { count: number; mean: number | null } }): string {
    const mean = row.stats.mean === null ? '' : ` · Ø ${formatAge(row.stats.mean)}`;
    return `${row.stats.count} ${row.stats.count === 1 ? 'Person' : 'Personen'}${mean}`;
  }
}
