import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BotifyVersionMetadata {
  base: string;
  branch: string;
  commit: string;
  version: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const metaFile = path.join(repoRoot, 'version-meta.json');
const packageFile = path.join(repoRoot, 'package.json');

function loadPackageVersion(): string {
  try {
    const packageRaw = fs.readFileSync(packageFile, 'utf8');
    const pkg = JSON.parse(packageRaw) as { version?: string };
    if (pkg.version && pkg.version.trim().length) {
      return pkg.version.trim();
    }
  } catch {
    // ignore
  }
  return '0.0.0';
}

function loadMetadata(): BotifyVersionMetadata {
  let metadata: Partial<BotifyVersionMetadata> = {};
  try {
    const raw = fs.readFileSync(metaFile, 'utf8');
    metadata = JSON.parse(raw) as BotifyVersionMetadata;
  } catch {
    metadata = {};
  }

  const base = metadata.base ?? loadPackageVersion();
  const branch = metadata.branch ?? 'unknown';
  const commit = metadata.commit ?? 'unknown';

  if (metadata.version) {
    return {
      base,
      branch,
      commit,
      version: metadata.version,
    };
  }

  const buildSegments = [];
  if (branch !== 'unknown') {
    buildSegments.push(branch);
  }
  if (commit !== 'unknown') {
    buildSegments.push(commit);
  }
  const version = buildSegments.length ? `${base}+${buildSegments.join('.')}` : base;

  return {
    base,
    branch,
    commit,
    version,
  };
}

export const botifyVersion = Object.freeze(loadMetadata());
export const versionString = botifyVersion.version;
export default botifyVersion;
