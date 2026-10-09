#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

/**
 * Packs the @urbicon-ui packages for the release workflow (`.github/workflows/release.yml`): one
 * tarball each into `release-tarballs/`, plus a `manifest.json` naming them in publish order. The
 * workflow's publish job uploads exactly these files — it has no checkout and runs no install, so
 * no dependency code shares a process with the npm credential.
 *
 * `bun pm pack` (not npm pack) resolves `workspace:`/`catalog:` to concrete versions and runs the
 * CLI's `prepack` build. Each tarball is checked before it can reach the irreversible publish: no
 * unresolved specifier left, the CLI bundle present, and — on a tag run (`RELEASE_TAG=vX.Y.Z`) —
 * the version the tag names.
 *
 * Usage: bun run scripts/pack-release.ts
 */

/** Publish order: config packages before the CLI, so the versions it pins already exist. */
const PACKAGES = ['tsconfig', 'biome-config', 'commitlint-config', 'cli'] as const;

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'release-tarballs');
/** A specifier `bun pm pack` should have resolved — left in, consumers cannot install it. */
const UNRESOLVED = /"(workspace|catalog):/;

interface Packed {
  name: string;
  version: string;
  file: string;
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const tag = process.env.RELEASE_TAG ?? '';
if (tag && !tag.startsWith('v')) fail(`RELEASE_TAG "${tag}" is not of the form vX.Y.Z`);
const tagVersion = tag.slice(1);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);

const manifest: Packed[] = [];
for (const dir of PACKAGES) {
  const cwd = join(ROOT, 'packages', dir);
  const { name, version } = (await Bun.file(join(cwd, 'package.json')).json()) as Packed;
  if (tagVersion && version !== tagVersion) fail(`${name} is ${version}, but the tag is ${tag}`);

  const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
  const tgz = join(OUT, file);
  await $`bun pm pack --filename ${tgz} --quiet`.cwd(cwd);

  const packedPkg = await $`tar -xzOf ${tgz} package/package.json`.text();
  if (UNRESOLVED.test(packedPkg)) {
    fail(`${name}: the packed package.json still has a workspace:/catalog: specifier`);
  }
  if (dir === 'cli' && !(await $`tar -tzf ${tgz}`.text()).includes('package/dist/bin/udx.js')) {
    fail(`${name}: dist/bin/udx.js is missing from the tarball — did the prepack build run?`);
  }

  manifest.push({ name, version, file });
  console.log(`packed  ${name}@${version} → ${file}`);
}

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
