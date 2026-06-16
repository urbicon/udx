import type { UserConfig } from '@commitlint/types';

export interface CreateConfigOptions {
  /**
   * Allowed commit scopes. Enforced as a warning (level 1), not as an error —
   * unknown scopes do not block the commit.
   */
  scopes?: string[];
  /** Additional or overriding commitlint rules. */
  rules?: UserConfig['rules'];
}

/** Builds a commitlint configuration based on `@commitlint/config-conventional`. */
export function createConfig(options?: CreateConfigOptions): UserConfig;

declare const config: UserConfig;
export default config;
