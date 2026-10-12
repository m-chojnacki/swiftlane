import { appendFileSync } from 'node:fs';

/** Exposes a value as a GitHub Actions step output so workflows can chain steps without guessing paths. */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}
