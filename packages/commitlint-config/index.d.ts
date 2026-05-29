import type { UserConfig } from '@commitlint/types';

export interface CreateConfigOptions {
  /**
   * Erlaubte Commit-Scopes. Als Warnung (Level 1) erzwungen, nicht als Fehler —
   * unbekannte Scopes blockieren den Commit nicht.
   */
  scopes?: string[];
  /** Zusätzliche oder überschreibende commitlint-Regeln. */
  rules?: UserConfig['rules'];
}

/** Baut eine commitlint-Konfiguration auf Basis von `@commitlint/config-conventional`. */
export function createConfig(options?: CreateConfigOptions): UserConfig;

declare const config: UserConfig;
export default config;
