/** Biome's formatter settings from `@urbicon-ui/biome-config` (coupled via a test). */
const INDENT = '  ';
const LINE_WIDTH = 100;

/**
 * Serializes like Biome formats a JSON file: objects expanded, an array of primitives on one
 * line when it fits the line width, otherwise one element per line. `JSON.stringify(v, null, 2)`
 * breaks every array, so a generated tsconfig.json failed the project's next `biome check`.
 * Not for package.json: Biome keeps its arrays expanded (as npm writes them), which is exactly
 * what `JSON.stringify` produces.
 */
export function formatJson(value: unknown): string {
  return `${render(value, '', 0)}\n`;
}

/** `around` = the columns the value's line holds besides the value itself (indent, key, comma). */
function render(value: unknown, indent: string, around: number): string {
  const inner = indent + INDENT;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const flat = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (value.every(isPrimitive) && around + flat.length <= LINE_WIDTH) return flat;
    const items = value.map((v, i) => {
      const comma = i < value.length - 1 ? ',' : '';
      return `${inner}${render(v, inner, inner.length + comma.length)}${comma}`;
    });
    return `[\n${items.join('\n')}\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const members = entries.map(([key, v], i) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      const comma = i < entries.length - 1 ? ',' : '';
      return `${head}${render(v, inner, head.length + comma.length)}${comma}`;
    });
    return `{\n${members.join('\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}
