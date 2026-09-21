import { useEffect, useState } from "react";

/**
 * useState that persists to localStorage under `key`.
 * Safe for SSR (checks for window), silently ignores quota errors.
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const storageKey = `vidflux:${key}`;

  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw == null) return initialValue;
      return JSON.parse(raw) as T;
    } catch (e) {
      console.warn(`[VidFlux] Failed to read ${storageKey}:`, e);
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (e) {
      console.warn(`[VidFlux] Failed to write ${storageKey}:`, e);
    }
  }, [storageKey, value]);

  return [value, setValue];
}