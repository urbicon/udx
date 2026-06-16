/**
 * @typedef {Object} CreateConfigOptions
 * @property {string[]} [scopes] Allowed commit scopes. Enforced as a warning
 *   (level 1), not as an error — unknown scopes do not block the commit.
 * @property {Record<string, unknown>} [rules] Additional/overriding rules.
 */

/**
 * Builds a commitlint configuration based on `@commitlint/config-conventional`.
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
