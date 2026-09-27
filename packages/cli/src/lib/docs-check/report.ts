import { c } from '../colors.ts';
import type { Report } from './check.ts';

/** Findings grouped by file, one `file:line  kind  what  →  why` per line, then the counts. */
export function formatReport(r: Report): string {
  const out: string[] = [];
  let current = '';
  for (const f of r.findings) {
    if (f.file !== current) {
      current = f.file;
      out.push('', c.bold(current));
    }
    const at = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    out.push(`  ${at}  ${f.kind}  ${f.what}  →  ${c.gray(f.why)}`);
  }
  out.push('');
  out.push(
    r.index
      ? `${r.index}: ${r.words} words (${r.budget === null ? 'no budget set' : `budget ${r.budget}`})`
      : 'no index file (AGENTS.md or CLAUDE.md): budget and delivery not checked'
  );
  if (!r.checkout)
    out.push(
      c.yellow('not a git checkout: the private, store and ignore questions had no git to ask')
    );
  out.push(
    `docs check: ${r.sources} sources, ${r.references} references, ${r.tracked} tracked files, ${r.workingDocs} working docs, ${r.findings.length} findings`
  );
  return out.join('\n');
}
