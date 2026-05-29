/**
 * @typedef {Object} CreateConfigOptions
 * @property {string[]} [scopes] Erlaubte Commit-Scopes. Als Warnung (Level 1)
 *   erzwungen, nicht als Fehler — unbekannte Scopes blockieren den Commit nicht.
 * @property {Record<string, unknown>} [rules] Zusätzliche/überschreibende Regeln.
 */

/**
 * Baut eine commitlint-Konfiguration auf Basis von `@commitlint/config-conventional`.
 *
 * @param {CreateConfigOptions} [options]
 * @returns {import('@commitlint/types').UserConfig}
 */
export function createConfig(options = {}) {
  const { scopes = [], rules = {} } = options;

  /** @type {import('@commitlint/types').UserConfig} */
  const config = {
    extends: ['@commitlint/config-conventional'],
    rules: { ...rules }
  };

  if (scopes.length > 0) {
    config.rules['scope-enum'] = [1, 'always', scopes];
  }

  return config;
}

export default createConfig();
