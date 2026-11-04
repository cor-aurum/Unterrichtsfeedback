import { inject, Pipe, PipeTransform } from '@angular/core';
import { Student } from './model';
import { StudentsStore } from './students.store';

/**
 * Name der Person für Listen und Auswahlen; gleichnamige Personen mit Geburtsdatum, z. B. „Anna Berg (geb.
 * 03.05.2015)“. Nicht rein, weil der Name auch von den anderen Personen abhängt.
 */
@Pipe({ name: 'studentLabel', pure: false })
export class StudentLabelPipe implements PipeTransform {
  private readonly store = inject(StudentsStore);

  transform(student: Student): string {
    return this.store.label(student);
  }
}
