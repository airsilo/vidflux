// Version string injected at build time by Vite.
// Falls back to "0.0.0-dev" if the define isn't set.

declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0-dev";