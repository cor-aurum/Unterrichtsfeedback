import { Injectable } from '@angular/core';
import { BlockImage, FeedbackConfig, FixedBlock, newId, Section, SectionScope, SectionType } from './model';
import { downloadFile, storedSignal } from './stored-signal';

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  readonly config = storedSignal<FeedbackConfig>('feedback.config', defaultConfig, parseConfig);

  setTitle(title: string): void {
    this.mutate((config) => (config.title = title));
  }

  addSection(type: SectionType): void {
    this.mutate((config) =>
      config.sections.push({
        id: newId(),
        title: type === 'checklist' ? 'Neue Textbausteine' : 'Neues Freitextfeld',
        type,
        scope: 'lesson',
        items: [],
      }),
    );
  }

  renameSection(sectionId: string, title: string): void {
    this.mutateSection(sectionId, (section) => (section.title = title));
  }

  setSectionScope(sectionId: string, scope: SectionScope): void {
    this.mutateSection(sectionId, (section) => (section.scope = scope));
  }

  removeSection(sectionId: string): void {
    this.mutate((config) => (config.sections = config.sections.filter((s) => s.id !== sectionId)));
  }

  moveSection(sectionId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.sections, sectionId, offset));
  }

  addItem(sectionId: string, text: string): void {
    this.mutateSection(sectionId, (section) => section.items.push({ id: newId(), text }));
  }

  updateItem(sectionId: string, itemId: string, text: string): void {
    this.mutateSection(sectionId, (section) => {
      const item = section.items.find((i) => i.id === itemId);
      if (item) item.text = text;
    });
  }

  removeItem(sectionId: string, itemId: string): void {
    this.mutateSection(sectionId, (section) => (section.items = section.items.filter((i) => i.id !== itemId)));
  }

  moveItem(sectionId: string, itemId: string, offset: -1 | 1): void {
    this.mutateSection(sectionId, (section) => move(section.items, itemId, offset));
  }

  exportToFile(): void {
    const json = JSON.stringify(this.config(), null, 2);
    downloadFile('feedback-konfiguration.json', new Blob([json], { type: 'application/json' }));
  }

  /** Übernimmt eine exportierte Konfiguration. Wirft einen Fehler, wenn die Datei kein gültiges Format hat. */
  importFromJson(json: string): void {
    this.config.set(parseConfig(JSON.parse(json)));
  }

  resetToDefault(): void {
    this.config.set(defaultConfig());
  }

  addTextBlock(): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'text', position: 'start', text: '' }),
    );
  }

  addImageBlock(image: BlockImage): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'image', position: 'start', text: '', image }),
    );
  }

  updateBlock(blockId: string, change: Partial<Pick<FixedBlock, 'text' | 'position' | 'image'>>): void {
    this.mutateBlock(blockId, (block) => Object.assign(block, change));
  }

  updateBlockImage(blockId: string, change: Partial<Pick<BlockImage, 'widthMm' | 'align'>>): void {
    this.mutateBlock(blockId, (block) => block.image && Object.assign(block.image, change));
  }

  removeBlock(blockId: string): void {
    this.mutate((config) => (config.blocks = config.blocks.filter((b) => b.id !== blockId)));
  }

  moveBlock(blockId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.blocks, blockId, offset));
  }

  private mutateBlock(blockId: string, change: (block: FixedBlock) => void): void {
    this.mutate((config) => {
      const block = config.blocks.find((b) => b.id === blockId);
      if (block) change(block);
    });
  }

  private mutateSection(sectionId: string, change: (section: Section) => void): void {
    this.mutate((config) => {
      const section = config.sections.find((s) => s.id === sectionId);
      if (section) change(section);
    });
  }

  private mutate(change: (config: FeedbackConfig) => void): void {
    const copy = structuredClone(this.config());
    change(copy);
    this.config.set(copy);
  }
}

function move<T extends { id: string }>(list: T[], id: string, offset: -1 | 1): void {
  const from = list.findIndex((entry) => entry.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
}

export function parseConfig(data: unknown): FeedbackConfig {
  const config = data as Partial<FeedbackConfig>;
  if (!config || typeof config !== 'object' || !Array.isArray(config.sections)) {
    throw new Error('Die Datei enthält keine Abschnitte.');
  }
  return {
    version: 1,
    title: typeof config.title === 'string' ? config.title : 'Unterrichtsfeedback',
    // Ältere Konfigurationen haben noch keine festen Blöcke.
    blocks: Array.isArray(config.blocks) ? config.blocks.map(parseBlock) : [],
    sections: config.sections.map(parseSection),
  };
}

function parseBlock(data: Partial<FixedBlock>): FixedBlock {
  if (data?.type !== 'text' && data?.type !== 'image') {
    throw new Error('Ein fester Block hat einen unbekannten Typ.');
  }
  if (data.type === 'image' && typeof data.image?.dataUrl !== 'string') {
    throw new Error('Ein festes Bild enthält keine Bilddaten.');
  }
  return {
    id: typeof data.id === 'string' ? data.id : newId(),
    type: data.type,
    position: data.position === 'end' ? 'end' : 'start',
    text: typeof data.text === 'string' ? data.text : '',
    image: data.image,
  };
}

function parseSection(data: Partial<Section>): Section {
  if (typeof data?.title !== 'string' || (data.type !== 'checklist' && data.type !== 'text')) {
    throw new Error('Ein Abschnitt hat keinen Titel oder einen unbekannten Typ.');
  }
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    id: typeof data.id === 'string' ? data.id : newId(),
    title: data.title,
    type: data.type,
    // Ältere Konfigurationen kennen den allgemeinen Teil noch nicht; Freitext gibt es nur je Stunde.
    scope: data.type === 'checklist' && data.scope === 'general' ? 'general' : 'lesson',
    items: items
      .filter((item) => typeof item?.text === 'string')
      .map((item) => ({ id: typeof item.id === 'string' ? item.id : newId(), text: item.text })),
  };
}

function defaultConfig(): FeedbackConfig {
  const checklist = (title: string, texts: string[], scope: SectionScope = 'lesson'): Section => ({
    id: newId(),
    title,
    type: 'checklist',
    scope,
    items: texts.map((text) => ({ id: newId(), text })),
  });
  const text = (title: string): Section => ({ id: newId(), title, type: 'text', scope: 'lesson', items: [] });

  return {
    version: 1,
    title: 'Dein Feedback zum Unterricht',
    blocks: [
      {
        id: newId(),
        type: 'text',
        position: 'start',
        text: 'Hallo {vorname},\n\nhier ist meine Rückmeldung zu unserem Unterricht. Lies sie dir in Ruhe durch und nimm die Aufgaben mit in deine Übezeit.',
      },
      {
        id: newId(),
        type: 'text',
        position: 'end',
        text: 'Viel Spaß beim Üben und bis zur nächsten Stunde!',
      },
    ],
    sections: [
      checklist(
        'Das zeichnet dich aus',
        [
          'Du kommst mit viel Freude und Neugier in den Unterricht.',
          'Du stellst gute Fragen und willst die Dinge wirklich verstehen.',
          'Auch bei schwierigen Stellen bleibst du geduldig dran.',
        ],
        'general',
      ),
      text('Unser Thema heute'),
      checklist('Vorbereitung', [
        'Du hast gut geübt und warst sehr gut vorbereitet.',
        'Du hast geübt, an einigen Stellen dürfen wir noch weiterarbeiten.',
        'Diese Woche bist du wenig zum Üben gekommen. Nimm dir bis zur nächsten Stunde etwas mehr Zeit dafür.',
      ]),
      checklist('Mitarbeit', [
        'Du hast konzentriert und motiviert mitgearbeitet.',
        'Du hast meine Anregungen schnell umgesetzt.',
        'Heute warst du etwas unkonzentriert, das kommt vor.',
      ]),
      checklist('Fortschritt', [
        'Seit der letzten Stunde hast du deutliche Fortschritte gemacht.',
        'Deine Technik hat sich verbessert.',
        'Rhythmus und Timing sind bei dir sicherer geworden.',
        'Dein Ausdruck und deine Gestaltung sind gewachsen.',
      ]),
      text('Das ist mir aufgefallen'),
      text('Deine Aufgaben bis zur nächsten Stunde'),
    ],
  };
}
