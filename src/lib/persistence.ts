import { DEFAULT_SETTINGS, HISTORY_KEY, SETTINGS_KEY } from '$lib/constants';
import type { SearchSettings } from '$lib/types';
import { normalizeWhitespace } from '$lib/utils';

export function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((entry) => normalizeWhitespace(String(entry))).filter(Boolean).slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

export function persistHistory(history: string[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
}

export function pushHistory(history: string[], entry: string): string[] {
  const clean = normalizeWhitespace(entry);
  if (!clean) {
    return history.slice(0, 10);
  }

  return [clean, ...history.filter((item) => item !== clean)].slice(0, 10);
}

export function loadSettings(): SearchSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      coreApiKey:
        typeof parsed?.coreApiKey === 'string' ? normalizeWhitespace(parsed.coreApiKey) : '',
      prioritizeReadyPdf:
        typeof parsed?.prioritizeReadyPdf === 'boolean'
          ? parsed.prioritizeReadyPdf
          : DEFAULT_SETTINGS.prioritizeReadyPdf,
      convertEpubToPdfByDefault:
        typeof parsed?.convertEpubToPdfByDefault === 'boolean'
          ? parsed.convertEpubToPdfByDefault
          : DEFAULT_SETTINGS.convertEpubToPdfByDefault,
      searchMode:
        parsed?.searchMode === 'focused' || parsed?.searchMode === 'complete'
          ? parsed.searchMode
          : DEFAULT_SETTINGS.searchMode
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings: SearchSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
