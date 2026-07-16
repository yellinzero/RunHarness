import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import en from "./messages/en.json";
import zh from "./messages/zh.json";

export type Locale = "en" | "zh";
type Messages = typeof en;
const messages: Record<Locale, Messages> = { en, zh };

interface I18nValue {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: string, values?: Record<string, string | number>): string;
}
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    localStorage.getItem("runharness.locale") === "en" ? "en" : "zh",
  );
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale(next) {
        localStorage.setItem("runharness.locale", next);
        document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
        setLocaleState(next);
      },
      t(key, values) {
        let current: unknown = messages[locale];
        for (const part of key.split("."))
          current = (current as Record<string, unknown> | undefined)?.[part];
        let text = typeof current === "string" ? current : key;
        for (const [name, replacement] of Object.entries(values ?? {}))
          text = text.replaceAll(`{${name}}`, String(replacement));
        return text;
      },
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
