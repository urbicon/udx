import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function exists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function writeText(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  if (mode !== undefined) chmodSync(path, mode);
}

export function remove(path: string): void {
  rmSync(path, { force: true });
}

export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function writeJson(path: string, data: unknown): void {
  writeText(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function abs(cwd: string, ...parts: string[]): string {
  return resolve(cwd, ...parts);
}
