import { Component, computed, inject } from '@angular/core';
import { ActiveTeacher } from '../active-teacher';
import { ConfigStore } from '../config.store';
import { GroupsStore } from '../groups.store';
import { Group, groupLabel, groupMembers, groupTeacherOf } from '../model';
import { StudentsStore } from '../students.store';
import { TeacherFilter } from '../teacher-filter';
import { oneColumn } from '../viewport';

/** Liste der Gruppen unter den Personen; neue Gruppen gehören zum aktiven Lehrer. */
@Component({
  selector: 'app-group-list',
  templateUrl: './group-list.html',
  styleUrl: './groups.scss',
})
export class GroupList {
  protected readonly store = inject(GroupsStore);
  private readonly oneColumn = oneColumn();
  private readonly students = inject(StudentsStore).students;
  private readonly config = inject(ConfigStore).config;
  private readonly activeTeacher = inject(ActiveTeacher);
  protected readonly multipleTeachers = computed(() => this.activeTeacher.visibleTeachers().length > 1);

  private readonly teacherFilter = inject(TeacherFilter);
  /** Gruppen, deren Lehrer zum Filter unter „Personen“ passt */
  protected readonly groups = computed(() =>
    this.store
      .groups()
      .filter((group) => this.teacherFilter.shows(groupTeacherOf(group, this.config()).id))
      .sort((a, b) => this.label(a).localeCompare(this.label(b), 'de')),
  );

  protected label(group: Group): string {
    return groupLabel(group, this.students());
  }

  protected memberCount(group: Group): number {
    return groupMembers(group, this.students()).length;
  }

  protected teacherName(group: Group): string {
    return groupTeacherOf(group, this.config()).name;
  }

  /** Auf dem Handy erst die Gruppe mit ihren Stunden, nicht gleich die neueste Stunde */
  protected choose(group: Group): void {
    this.store.select(group.id);
    if (this.oneColumn()) {
      this.store.selectedLessonId.set(null);
      window.scrollTo({ top: 0 });
    }
  }

  protected add(): void {
    this.store.add(this.activeTeacher.teacher().id);
  }
}
