import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DANGEROUS_CHAR_PATTERN = /[\0\x01-\x1f\x7f]/;
const EXPLICIT_WORKSPACE_ENV_KEYS = [
  'CGFLOW_ALLOWED_WORKSPACE_PATHS',
  'CGFLOW_WORKSPACE_PATHS',
  'CGFLOW_WORKSPACE_PATH',
  'WORKSPACE_PATH',
];

function parseWorkspacePathsFromEnv(): string[] {
  const explicitPaths: string[] = [];
  for (const key of EXPLICIT_WORKSPACE_ENV_KEYS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    for (const piece of raw.split(path.delimiter)) {
      const candidate = piece.trim();
      if (candidate) explicitPaths.push(candidate);
    }
  }
  return explicitPaths;
}

function getBuiltinWorkspaceDirs(): string[] {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const cgflowGuiRoot = path.resolve(moduleDir, '..');
    const repoRoot = path.resolve(cgflowGuiRoot, '..');
    const cgflowRoot = path.resolve(repoRoot, 'cgflow');
    return [cgflowGuiRoot, repoRoot, cgflowRoot];
  } catch {
    return [];
  }
}

function normalizeBaseDir(baseDir: string): string {
  const normalized = path.resolve(baseDir);
  return path.normalize(normalized);
}

function isUnderBaseDir(targetPath: string, baseDir: string): boolean {
  const normalizedTarget = path.normalize(path.resolve(targetPath));
  const normalizedBase = normalizeBaseDir(baseDir);
  const relative = path.relative(normalizedBase, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function sanitizePath(inputPath: string): string {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('Path must be a non-empty string');
  }
  if (DANGEROUS_CHAR_PATTERN.test(inputPath)) {
    throw new Error('Path contains dangerous characters');
  }
  return path.normalize(path.resolve(inputPath));
}

export function isPathContained(targetPath: string, allowedBaseDirs: string[]): boolean {
  const sanitizedTarget = sanitizePath(targetPath);
  return allowedBaseDirs.some((baseDir) => {
    try {
      const sanitizedBaseDir = sanitizePath(baseDir);
      return isUnderBaseDir(sanitizedTarget, sanitizedBaseDir);
    } catch {
      return false;
    }
  });
}

function getAllowedBaseDirs(): string[] {
  const homeDir = os.homedir();
  const runnerDir = path.join(homeDir, '.cgflow-runner');
  const configuredWorkspaceDirs = [
    ...getBuiltinWorkspaceDirs(),
    ...parseWorkspacePathsFromEnv(),
  ].map(normalizeBaseDir);

  return Array.from(new Set([homeDir, runnerDir, ...configuredWorkspaceDirs].map(normalizeBaseDir)));
}

function getWriteAllowedBaseDirs(): string[] {
  const homeDir = os.homedir();
  const runnerDir = path.join(homeDir, '.cgflow-runner');
  const configuredWorkspaceDirs = [
    ...getBuiltinWorkspaceDirs(),
    ...parseWorkspacePathsFromEnv(),
  ].map(normalizeBaseDir);

  return Array.from(new Set([runnerDir, ...configuredWorkspaceDirs].map(normalizeBaseDir)));
}

export function validateFilePath(filePath: string, operation: 'read' | 'write'): void {
  const sanitizedPath = sanitizePath(filePath);
  const allowedDirs = operation === 'write' ? getWriteAllowedBaseDirs() : getAllowedBaseDirs();

  if (!isPathContained(sanitizedPath, allowedDirs)) {
    throw new Error(
      `Path is not allowed for ${operation}: ${sanitizedPath}. Allowed base dirs: ${allowedDirs.join(', ')}`
    );
  }
}
