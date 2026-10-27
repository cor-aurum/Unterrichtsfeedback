import { computed, Injectable } from '@angular/core';
import {
  BlockContent,
  BlockImage,
  BlockPosition,
  BlockVariant,
  defaultInstrument,
  FeedbackConfig,
  FixedBlock,
  Instrument,
  newId,
  Section,
  SectionScope,
  SectionType,
} from './model';
import { downloadFile, storedSignal } from './stored-signal';
import { DEFAULT_THEME_COLOR, isHexColor, themeFrom } from './theme';

/** Standardinhalt (`variantId` = null) oder eine Variante eines festen Blocks */
export interface ContentTarget {
  blockId: string;
  variantId: string | null;
}

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  readonly config = storedSignal<FeedbackConfig>('feedback.config', defaultConfig, parseConfig);

  readonly theme = computed(() => themeFrom(this.config().themeColor));

  setTitle(title: string): void {
    this.mutate((config) => (config.title = title));
  }

  setThemeColor(color: string): void {
    if (isHexColor(color)) this.mutate((config) => (config.themeColor = color.toLowerCase()));
  }

  addSection(type: SectionType): void {
    this.mutate((config) =>
      config.sections.push({
        id: newId(),
        title: type === 'checklist' ? 'Neue Textbausteine' : 'Neues Freitextfeld',
        type,
        scope: 'lesson',
        showTitle: true,
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

  setShowTitle(sectionId: string, showTitle: boolean): void {
    this.mutateSection(sectionId, (section) => (section.showTitle = showTitle));
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

  addInstrument(name: string): void {
    this.mutate((config) => config.instruments.push({ id: newId(), name }));
  }

  renameInstrument(instrumentId: string, name: string): void {
    this.mutate((config) => {
      const instrument = config.instruments.find((i) => i.id === instrumentId);
      if (instrument) instrument.name = name;
    });
  }

  setDefaultInstrument(instrumentId: string): void {
    this.mutate((config) => (config.defaultInstrumentId = instrumentId));
  }

  /**
   * Entfernt das Instrument auch aus allen Varianten. Personen mit diesem Instrument bekommen das
   * Standardinstrument. Das letzte Instrument bleibt immer erhalten.
   */
  removeInstrument(instrumentId: string): void {
    this.mutate((config) => {
      if (config.instruments.length <= 1) return;
      config.instruments = config.instruments.filter((i) => i.id !== instrumentId);
      config.defaultInstrumentId = defaultInstrument(config).id;
      config.blocks
        .flatMap((block) => block.variants)
        .forEach((variant) => (variant.instrumentIds = variant.instrumentIds.filter((id) => id !== instrumentId)));
    });
  }

  moveInstrument(instrumentId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.instruments, instrumentId, offset));
  }

  addTextBlock(): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'text', position: 'start', text: '', variants: [] }),
    );
  }

  addImageBlock(image: BlockImage): void {
    this.mutate((config) =>
      config.blocks.push({ id: newId(), type: 'image', position: 'start', text: '', image, variants: [] }),
    );
  }

  setBlockPosition(blockId: string, position: BlockPosition): void {
    this.mutateBlock(blockId, (block) => (block.position = position));
  }

  removeBlock(blockId: string): void {
    this.mutate((config) => (config.blocks = config.blocks.filter((b) => b.id !== blockId)));
  }

  moveBlock(blockId: string, offset: -1 | 1): void {
    this.mutate((config) => move(config.blocks, blockId, offset));
  }

  addVariant(blockId: string): void {
    this.mutateBlock(blockId, (block) => block.variants.push({ id: newId(), instrumentIds: [], text: '' }));
  }

  removeVariant(blockId: string, variantId: string): void {
    this.mutateBlock(blockId, (block) => (block.variants = block.variants.filter((v) => v.id !== variantId)));
  }

  toggleVariantInstrument(blockId: string, variantId: string, instrumentId: string): void {
    this.mutateBlock(blockId, (block) => {
      const variant = block.variants.find((v) => v.id === variantId);
      if (!variant) return;
      variant.instrumentIds = variant.instrumentIds.includes(instrumentId)
        ? variant.instrumentIds.filter((id) => id !== instrumentId)
        : [...variant.instrumentIds, instrumentId];
    });
  }

  /** Ändert den Standardinhalt (`target.variantId` = null) oder eine Variante eines Blocks. */
  updateContent(target: ContentTarget, change: Partial<BlockContent>): void {
    this.mutateContent(target, (content) => Object.assign(content, change));
  }

  updateContentImage(target: ContentTarget, change: Partial<Pick<BlockImage, 'widthMm' | 'align'>>): void {
    this.mutateContent(target, (content) => content.image && Object.assign(content.image, change));
  }

  private mutateContent(target: ContentTarget, change: (content: BlockContent) => void): void {
    this.mutateBlock(target.blockId, (block) => {
      const content = target.variantId ? block.variants.find((v) => v.id === target.variantId) : block;
      if (content) change(content);
    });
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
  // Ältere Konfigurationen haben noch keine Instrumente; es muss aber immer eins geben.
  const instruments = Array.isArray(config.instruments) ? config.instruments.map(parseInstrument) : [];
  if (instruments.length === 0) instruments.push({ id: newId(), name: 'Instrument' });
  const defaultInstrumentId = instruments.some((i) => i.id === config.defaultInstrumentId)
    ? config.defaultInstrumentId!
    : instruments[0].id;
  return {
    version: 1,
    title: typeof config.title === 'string' ? config.title : 'Unterrichtsfeedback',
    themeColor: isHexColor(config.themeColor) ? config.themeColor : DEFAULT_THEME_COLOR,
    instruments,
    defaultInstrumentId,
    // Ältere Konfigurationen haben noch keine festen Blöcke.
    blocks: Array.isArray(config.blocks) ? config.blocks.map(parseBlock) : [],
    sections: config.sections.map(parseSection),
  };
}

function parseInstrument(data: Partial<Instrument>): Instrument {
  if (typeof data?.name !== 'string') {
    throw new Error('Ein Instrument hat keinen Namen.');
  }
  return { id: typeof data.id === 'string' ? data.id : newId(), name: data.name };
}

function parseBlock(data: Partial<FixedBlock>): FixedBlock {
  if (data?.type !== 'text' && data?.type !== 'image') {
    throw new Error('Ein fester Block hat einen unbekannten Typ.');
  }
  return {
    id: typeof data.id === 'string' ? data.id : newId(),
    type: data.type,
    position: data.position === 'end' ? 'end' : 'start',
    ...parseContent(data),
    variants: Array.isArray(data.variants) ? data.variants.map(parseVariant) : [],
  };
}

function parseVariant(data: Partial<BlockVariant>): BlockVariant {
  return {
    id: typeof data?.id === 'string' ? data.id : newId(),
    instrumentIds: Array.isArray(data?.instrumentIds) ? data.instrumentIds.filter((id) => typeof id === 'string') : [],
    ...parseContent(data),
  };
}

function parseContent(data: Partial<BlockContent>): BlockContent {
  if (data.image !== undefined && typeof data.image?.dataUrl !== 'string') {
    throw new Error('Ein festes Bild enthält keine Bilddaten.');
  }
  return { text: typeof data.text === 'string' ? data.text : '', image: data.image };
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
    // Ältere Konfigurationen kennen den allgemeinen Teil noch nicht.
    scope: data.scope === 'general' ? 'general' : 'lesson',
    showTitle: data.showTitle !== false,
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
    showTitle: true,
    items: texts.map((text) => ({ id: newId(), text })),
  });
  const text = (title: string): Section => ({ id: newId(), title, type: 'text', scope: 'lesson', showTitle: true, items: [] });

  const piano = { id: newId(), name: 'Klavier' };
  const guitar = { id: newId(), name: 'Gitarre' };
  const violin = { id: newId(), name: 'Violine' };

  return {
    version: 1,
    title: 'Dein Feedback zum Unterricht',
    themeColor: DEFAULT_THEME_COLOR,
    instruments: [piano, guitar, violin],
    defaultInstrumentId: piano.id,
    blocks: [
      {
        id: newId(),
        type: 'text',
        position: 'start',
        text: 'Hallo {vorname},\n\nhier ist meine Rückmeldung zu unserem Unterricht. Lies sie dir in Ruhe durch und nimm die Aufgaben mit in deine Übezeit.',
        variants: [],
      },
      {
        id: newId(),
        type: 'text',
        position: 'end',
        text: 'Viel Spaß beim Üben und bis zur nächsten Stunde!',
        variants: [
          {
            id: newId(),
            instrumentIds: [guitar.id, violin.id],
            text: 'Viel Spaß beim Üben und bis zur nächsten Stunde! Denk daran, deine {instrument} vor dem Spielen zu stimmen.',
          },
        ],
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
