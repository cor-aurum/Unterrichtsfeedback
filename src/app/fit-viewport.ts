import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** Abstand zum unteren Bildschirmrand (wie `top: 1rem` beim Stehenbleiben) */
const BOTTOM_GAP_PX = 16;

/**
 * Für eine Spalte, die beim Scrollen stehen bleibt (`position: sticky`) und für sich scrollt: Sie ist nie höher als
 * der sichtbare Rest des Bildschirms ab ihrer Oberkante. Oben auf der Seite, wo noch Kopfleiste und Hinweise darüber
 * stehen, wäre sie mit fester Höhe unten abgeschnitten, und man müsste die ganze Seite scrollen, um ans Ende der Liste
 * zu kommen. Ohne `sticky` (eine Spalte auf schmalen Bildschirmen) bleibt die Höhe frei.
 */
@Directive({ selector: '[appFitViewport]' })
export class FitViewport {
  private readonly element = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private frame = 0;

  constructor() {
    const update = () => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.fit());
    };
    // Auch wenn sich darüber etwas ändert, ohne dass gescrollt wird (z. B. „Heute geplant“ erscheint)
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    afterNextRender(() => {
      this.fit();
      window.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      resize?.observe(document.body);
    });
    inject(DestroyRef).onDestroy(() => {
      resize?.disconnect();
      cancelAnimationFrame(this.frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    });
  }

  private fit(): void {
    if (getComputedStyle(this.element).position !== 'sticky') {
      this.element.style.maxHeight = '';
      return;
    }
    // Höchstens bis zur Stelle, an der die Spalte stehen bleibt (`top: 1rem`)
    const top = Math.max(this.element.getBoundingClientRect().top, BOTTOM_GAP_PX);
    this.element.style.maxHeight = `${Math.max(window.innerHeight - top - BOTTOM_GAP_PX, 200)}px`;
  }
}
