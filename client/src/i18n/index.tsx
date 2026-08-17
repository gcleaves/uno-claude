import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorCode, LogEntry } from '@uno/shared';
import { cardName, type Params, type Strings } from './strings';
import { en } from './en';
import { es } from './es';
import { it } from './it';
import { track } from '../analytics';

export const LOCALES = { en, es, it } as const;
export type LocaleCode = keyof typeof LOCALES;
export const LOCALE_CODES = Object.keys(LOCALES) as LocaleCode[];

const STORAGE_KEY = 'uno.locale';

/**
 * Remembered choice first, then the browser's preference, then English. The
 * source is reported alongside the locale, because "picked Spanish" and "was
 * given Spanish by their browser" mean different things when deciding whether
 * the translations are earning their keep.
 */
function initialLocale(): { locale: LocaleCode; source: 'stored' | 'browser' | 'default' } {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && saved in LOCALES) return { locale: saved as LocaleCode, source: 'stored' };
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.split('-')[0];
    if (base && base in LOCALES) return { locale: base as LocaleCode, source: 'browser' };
  }
  return { locale: 'en', source: 'default' };
}

export interface I18n {
  locale: LocaleCode;
  setLocale: (next: LocaleCode) => void;
  /** The current locale's strings. */
  s: Strings;
  /** Render a server log entry. */
  log: (entry: LogEntry) => string;
  /** Render a server error code. */
  error: (code: ErrorCode, params?: Params) => string;
  /** Name a card in this language. */
  card: (card: Parameters<typeof cardName>[0]) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [initial] = useState(initialLocale);
  const [locale, setLocaleState] = useState<LocaleCode>(initial.locale);
  const s = LOCALES[locale];

  // Which language a session starts in, and whether that was a choice. Guarded
  // because StrictMode runs effects twice in development, which would otherwise
  // double-count every session.
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    track('language ready', { locale: initial.locale, source: initial.source });
  }, [initial]);

  const setLocale = useCallback(
    (next: LocaleCode) => {
      localStorage.setItem(STORAGE_KEY, next);
      setLocaleState((from) => {
        if (from !== next) track('language changed', { from, to: next });
        return next;
      });
    },
    [],
  );

  // Keep the document language honest for screen readers and hyphenation.
  useEffect(() => {
    document.documentElement.lang = s.locale;
  }, [s.locale]);

  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      s,
      log: (entry) => s.log[entry.key](entry.params ?? {}, entry.card ? cardName(entry.card, s) : ''),
      error: (code, params) => (s.error[code] ?? s.error.couldNotJoin)(params ?? {}, ''),
      card: (c) => cardName(c, s),
    }),
    [locale, setLocale, s],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Compact language switcher. Available before, during and after a game. */
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, s } = useI18n();
  return (
    <label className="lang" data-compact={compact}>
      <span className="sr-only">{s.ui.language}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as LocaleCode)}
        aria-label={s.ui.language}
      >
        {LOCALE_CODES.map((code) => (
          <option key={code} value={code}>
            {compact ? code.toUpperCase() : LOCALES[code].languageName}
          </option>
        ))}
      </select>
    </label>
  );
}

export type { Strings };
