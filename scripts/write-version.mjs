#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const metaPath = path.join(repoRoot, 'version-meta.json');

function runGit(command) {
  try {
    return execSync(command, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function sanitizeSegment(value) {
  if (!value) {
    return '';
  }
  return value
    .replace(/[^0-9A-Za-z-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const pkgRaw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);
const baseVersion = typeof pkg.version === 'string' && pkg.version.trim().length ? pkg.version.trim() : '0.0.0';

const detectedBranch = process.env.BOTIFY_BUILD_BRANCH ?? runGit('git rev-parse --abbrev-ref HEAD');
const detectedCommit = process.env.BOTIFY_BUILD_COMMIT ?? runGit('git rev-parse --short HEAD');

const branch = detectedBranch && detectedBranch !== 'HEAD' ? detectedBranch : '';
const commit = detectedCommit || '';

const sanitizedBranch = sanitizeSegment(branch);
const sanitizedCommit = sanitizeSegment(commit);
const buildSegments = [];
if (sanitizedBranch) {
  buildSegments.push(sanitizedBranch);
}
if (sanitizedCommit) {
  buildSegments.push(sanitizedCommit);
}

const composedVersion = buildSegments.length ? `${baseVersion}+${buildSegments.join('.')}` : baseVersion;

const metadata = {
  base: baseVersion,
  branch: branch || 'unknown',
  commit: commit || 'unknown',
  version: composedVersion,
};

writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`Botify version metadata captured: ${metadata.version} (branch: ${metadata.branch}, commit: ${metadata.commit})`);
