import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(exampleRoot, '../..');

/** Load `.env` in this example dir and repo-root `.env.agent-pay` without overriding real env. */
export function loadEnvFiles() {
  for (const candidate of [
    join(exampleRoot, '.env'),
    join(repoRoot, '.env.agent-pay'),
    join(process.cwd(), '.env.agent-pay'),
  ]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() ?? fallback;
}

export const DEFAULT_MCP_URL = 'https://agent-connect-app-production.up.railway.app/mcp';
export const DEFAULT_STAGING_BASE = 'https://staging.pingpay.io';
export const DEFAULT_ACCOUNT = 'Checking';
/** NEAR Intents USDC — source balance for `withdraw` with `chain: base` (live E2E). */
export const DEFAULT_NEAR_USDC_TOKEN =
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
