import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { spawn, ChildProcess, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { ConvexHttpClient } from 'convex/browser';
import type {
  BoltzMetricInputRow,
  BoltzMetricSeries,
  NormalizedPdbFile,
  OptConfig,
  RunInfo,
  MoleculeResult,
  RewardCacheEntry,
  BoltzScore,
  TrajectoryStep,
  OptimizationEngine,
} from '../shared/types';
import {
  OptConfigSchema,
  RunnerFilePathPayloadSchema,
  RunnerImportPayloadSchema,
  RunnerResumePayloadSchema,
  RunnerStartPayloadSchema,
} from '../shared/types';
import { normalizePdbResiduesToOneIndexed } from '../shared/pdbResidues';
import { computeBoltzMetrics } from '../shared/boltzMetrics';
import { getConvexSyncService } from './convex-sync';
import { api } from '../convex/_generated/api';
import {
  getFlashbindComplexContent,
  getFlashbindMetricRowsFromRunDir,
  getFlashbindTopMolecules,
} from './engines/flashbindAdapter';
import { isPathContained, validateFilePath } from './pathSecurity';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CGFLOW_ROOT = path.resolve(__dirname, '../../cgflow');
const OPT_BOLTZ_SCRIPT = path.join(CGFLOW_ROOT, 'scripts/opt/opt_boltz.py');
const OPT_FLASHBIND_SCRIPT = path.join(CGFLOW_ROOT, 'scripts/opt/opt_flashbind.py');
const CONDA_ENV_NAME = process.env.CGFLOW_CONDA_ENV?.trim() || 'cgflow';

function normalizeEngine(engine: unknown): OptimizationEngine {
  return engine === 'flashbind' ? 'flashbind' : 'boltz';
}

function getOptScriptForEngine(engine: OptimizationEngine): string {
  return engine === 'flashbind' ? OPT_FLASHBIND_SCRIPT : OPT_BOLTZ_SCRIPT;
}

const DEFAULT_FLASHBIND_CONFIG = {
  root: './src/FlashBind',
  protein_id: '',
  pdb_dir: '',
  protein_repr: '',
  ligand_repr: '',
  prots_json: null as string | null,
  fabind_checkpoint: '',
  binary_checkpoints: [] as string[],
  value_checkpoints: [] as string[],
  fabind_conda_env: 'fabind',
  flashbind_conda_env: 'flashaffinity',
  fabind_num_threads: 8,
  fabind_batch_size: 4,
  fabind_post_optim: true,
  devices: 1,
  accelerator: 'gpu',
  num_workers: 16,
  distance_threshold: 20,
  repr_n_jobs: -1,
  auto_generate_protein_repr: true,
  auto_generate_ligand_repr: true,
  reward_cache_path: null as string | null,
  hf_cache: null as string | null,
};

function spawnCgflowPython(args: string[], options: SpawnOptions): ChildProcess {
  return spawn(
    'conda',
    ['run', '--no-capture-output', '-n', CONDA_ENV_NAME, 'python', ...args],
    options
  );
}

const DEFAULT_PORT = 45731;
const RESULT_DIR_INITIAL_DETECTION_ATTEMPTS = 30;
const RESULT_DIR_INITIAL_DETECTION_INTERVAL_MS = 1000;
const RESULT_DIR_REFRESH_INTERVAL_MS = 10000;

interface RunnerOptions {
  dataDir?: string;
  convexUrl?: string;
  port?: number;
}

function parseRunnerPortFromEnv(): number | undefined {
  const fromPort = process.env.CGFLOW_RUNNER_PORT ?? process.env.VITE_RUNNER_PORT;
  if (fromPort) {
    const parsed = Number.parseInt(fromPort, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const runnerUrl = process.env.VITE_RUNNER_URL?.trim();
  if (runnerUrl) {
    try {
      const url = new URL(runnerUrl);
      if (url.port) {
        const parsed = Number.parseInt(url.port, 10);
        if (Number.isFinite(parsed)) return parsed;
      }
      return url.protocol === 'https:' ? 443 : 80;
    } catch {
      // Ignore invalid URL values and fall back to default port.
    }
  }

  return undefined;
}

export function parseRunnerOptionsFromEnv(overrides: RunnerOptions = {}): RunnerOptions {
  const port = overrides.port ?? parseRunnerPortFromEnv();
  const convexUrl =
    overrides.convexUrl ?? process.env.VITE_CONVEX_URL ?? process.env.CONVEX_URL;

  return {
    ...overrides,
    ...(port !== undefined ? { port } : {}),
    ...(convexUrl ? { convexUrl } : {}),
  };
}

async function loadEnvFile(envPath: string, overwrite: boolean): Promise<void> {
  try {
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!key) continue;
      if (overwrite || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Env file is optional.
  }
}

async function loadDotEnvIfPresent(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  await loadEnvFile(path.join(root, '.env'), false);
  await loadEnvFile(path.join(root, '.env.local'), true);
}

async function probeRunnerHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET' });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === 'ok';
  } catch {
    return false;
  }
}

function shouldReuseExistingRunner(): boolean {
  const raw = process.env.CGFLOW_RUNNER_REUSE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function registerRunnerShutdown(args: {
  server: http.Server;
  processes: Map<string, ChildProcess>;
  sseClients: Set<http.ServerResponse>;
  stopResultDirRefresh: (runId: string) => void;
}): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nCGFlow runner shutting down (${signal})...`);

    for (const [runId, proc] of args.processes) {
      args.stopResultDirRefresh(runId);
      if (!proc.killed) {
        proc.kill('SIGINT');
      }
    }

    for (const client of args.sseClients) {
      client.end();
    }
    args.sseClients.clear();

    await new Promise<void>((resolve) => {
      args.server.close(() => resolve());
    });

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function listenRunnerServer(
  server: http.Server,
  port: number
): Promise<{ owned: boolean }> {
  if (await probeRunnerHealth(port)) {
    if (shouldReuseExistingRunner()) {
      console.log(
        `CGFlow runner already running at http://127.0.0.1:${port} (reusing existing process)`
      );
      return { owned: false };
    }
    throw new Error(
      `Port ${port} is already in use by an existing CGFlow runner. Stop it first (for example: fuser -k ${port}/tcp) or set CGFLOW_RUNNER_REUSE=1 to reuse it.`
    );
  }

  let owned = true;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        void probeRunnerHealth(port).then((healthy) => {
          if (healthy && shouldReuseExistingRunner()) {
            console.log(
              `CGFlow runner already running at http://127.0.0.1:${port} (reusing existing process)`
            );
            owned = false;
            resolve();
            return;
          }
          if (healthy) {
            reject(
              new Error(
                `Port ${port} is already in use by an existing CGFlow runner. Stop it first (for example: fuser -k ${port}/tcp) or set CGFLOW_RUNNER_REUSE=1 to reuse it.`
              )
            );
            return;
          }
          reject(
            new Error(
              `Port ${port} is already in use by another process. Stop it or set CGFLOW_RUNNER_PORT to a free port.`
            )
          );
        });
        return;
      }
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`CGFlow runner listening on http://127.0.0.1:${port}`);
      resolve();
    });
  });

  return { owned };
}

interface RunRecord extends RunInfo {
  pid: number | null;
  convexRunId?: string | null;
  source?: 'local';
  logPath?: string | null;
}

interface RunnerStartPayload {
  config?: OptConfig;
  configPath?: string | null;
  name?: string | null;
}


interface RunnerState {
  runs: Map<string, RunRecord>;
  outputs: Map<string, string[]>;
  processes: Map<string, ChildProcess>;
}

// ============================================================================
// SQL.js helpers
// ============================================================================

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

async function openDatabase(dbPath: string): Promise<SqlJsDatabase> {
  validateFilePath(dbPath, 'read');
  const sql = await initSQL();
  const buffer = await fs.readFile(dbPath);
  return new sql.Database(buffer);
}

function queryAll<T>(db: SqlJsDatabase, sql: string, params: any[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

// ============================================================================
// Runner utilities
// ============================================================================

function formatTimestamp(date = new Date()): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yy}${mm}${dd}_${hh}${mi}${ss}`;
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCondaCommand(args: string[]): string {
  const full = ['conda', 'run', '--no-capture-output', '-n', CONDA_ENV_NAME, 'python', ...args];
  return full.map(shellQuote).join(' ');
}

function summarizeFailureFromOutput(
  outputLines: string[],
  maxLines = 20
): string[] {
  if (outputLines.length === 0) return [];
  const stderrLines = outputLines.filter((line) => line.includes('[stderr]'));
  let tracebackStart = -1;
  for (let i = outputLines.length - 1; i >= 0; i -= 1) {
    if (/Traceback \(most recent call last\):/i.test(outputLines[i] ?? '')) {
      tracebackStart = i;
      break;
    }
  }

  if (tracebackStart >= 0) {
    return outputLines.slice(tracebackStart).slice(-maxLines);
  }
  if (stderrLines.length > 0) {
    return stderrLines.slice(-maxLines);
  }
  return outputLines.slice(-maxLines);
}

function buildFailureMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  outputLines: string[];
  logPath: string | null | undefined;
  command: string;
}): string {
  const parts: string[] = [];
  const statusCore =
    params.code !== null
      ? `exit code ${params.code}`
      : `signal ${params.signal ?? 'unknown'}`;
  parts.push(`Training process failed (${statusCore}).`);
  if (params.logPath) {
    parts.push(`Log: ${params.logPath}`);
  }
  parts.push(`Command: ${params.command}`);

  const snippet = summarizeFailureFromOutput(params.outputLines);
  if (snippet.length > 0) {
    parts.push('Recent output:');
    parts.push(...snippet);
  }
  return parts.join('\n');
}

function isConvexPath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('convex://');
}

function parseConvexPath(value: string): { id: string; name?: string } | null {
  if (!value.startsWith('convex://')) return null;
  const parts = value.replace('convex://', '').split('::');
  return { id: parts[0]!, name: parts[1] };
}

function defaultImportedConfig(resultDir: string): OptConfig {
  return {
    engine: 'boltz',
    result_dir: resultDir,
    env_dir: './data/envs/enamine_stock_new',
    max_atoms: 60,
    subsampling_ratio: 0.1,
    protein_path: '',
    center: null,
    ref_ligand_path: null,
    size: [16, 16, 16],
    num_steps: 0,
    num_sampling_per_step: 32,
    temperature: [1, 64],
    seed: 481,
    pose_model: './weights/cgflow_crossdock.ckpt',
    pose_steps: 40,
    sampling_tau: 0.9,
    random_action_prob: 0.05,
    replay_warmup_step: 10,
    replay_capacity: 6400,
    boltz: {
      base_yaml: '',
      target_residues: [],
      msa_path: null,
      cache_dir: null,
      use_msa_server: false,
      worker: 1,
    },
    flashbind: { ...DEFAULT_FLASHBIND_CONFIG },
  };
}

function toNumberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function toArray3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      toNumberOrDefault(value[0], fallback[0]),
      toNumberOrDefault(value[1], fallback[1]),
      toNumberOrDefault(value[2], fallback[2]),
    ];
  }
  return fallback;
}

function toArray2(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value) && value.length >= 2) {
    return [
      toNumberOrDefault(value[0], fallback[0]),
      toNumberOrDefault(value[1], fallback[1]),
    ];
  }
  return fallback;
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeImportedConfig(raw: unknown, resultDir: string): OptConfig {
  const base = defaultImportedConfig(resultDir);
  if (!raw || typeof raw !== 'object') return base;

  const record = raw as Record<string, unknown>;
  const boltzRaw =
    (record.boltz && typeof record.boltz === 'object' ? (record.boltz as Record<string, unknown>) : null) ??
    {};
  const flashbindRaw =
    (record.flashbind && typeof record.flashbind === 'object'
      ? (record.flashbind as Record<string, unknown>)
      : null) ?? {};

  const normalized: OptConfig = {
    engine: normalizeEngine(record.engine),
    result_dir: (record.result_dir as string) || (record.resultDir as string) || base.result_dir,
    env_dir: (record.env_dir as string) || (record.envDir as string) || base.env_dir,
    max_atoms: toNumberOrDefault(record.max_atoms ?? record.maxAtoms, base.max_atoms),
    subsampling_ratio: toNumberOrDefault(
      record.subsampling_ratio ?? record.subsamplingRatio,
      base.subsampling_ratio
    ),
    protein_path: (record.protein_path as string) || (record.proteinPath as string) || base.protein_path,
    center:
      Array.isArray(record.center) && record.center.length >= 3
        ? [
            toNumberOrDefault(record.center[0], 0),
            toNumberOrDefault(record.center[1], 0),
            toNumberOrDefault(record.center[2], 0),
          ]
        : null,
    ref_ligand_path: toOptionalString(record.ref_ligand_path ?? record.refLigandPath),
    size: toArray3(record.size, base.size),
    num_steps: toNumberOrDefault(record.num_steps ?? record.numSteps, base.num_steps),
    num_sampling_per_step: toNumberOrDefault(
      record.num_sampling_per_step ?? record.numSamplingPerStep,
      base.num_sampling_per_step
    ),
    temperature: toArray2(record.temperature, base.temperature),
    seed: toNumberOrDefault(record.seed, base.seed),
    pose_model: (record.pose_model as string) || (record.poseModel as string) || base.pose_model,
    pose_steps: toNumberOrDefault(record.pose_steps ?? record.poseSteps, base.pose_steps),
    sampling_tau: toNumberOrDefault(record.sampling_tau ?? record.samplingTau, base.sampling_tau),
    random_action_prob: toNumberOrDefault(
      record.random_action_prob ?? record.randomActionProb,
      base.random_action_prob
    ),
    replay_warmup_step: toNumberOrDefault(
      record.replay_warmup_step ?? record.replayWarmupStep,
      base.replay_warmup_step
    ),
    replay_capacity: toNumberOrDefault(record.replay_capacity ?? record.replayCapacity, base.replay_capacity),
    boltz: {
      base_yaml:
        (boltzRaw.base_yaml as string) ||
        (boltzRaw.baseYaml as string) ||
        (record.boltzBaseYaml as string) ||
        base.boltz.base_yaml,
      target_residues: Array.isArray(boltzRaw.target_residues)
        ? boltzRaw.target_residues.filter((x): x is string => typeof x === 'string')
        : Array.isArray(boltzRaw.targetResidues)
        ? boltzRaw.targetResidues.filter((x): x is string => typeof x === 'string')
        : base.boltz.target_residues,
      msa_path: toOptionalString(boltzRaw.msa_path ?? boltzRaw.msaPath ?? record.boltzMsaPath),
      cache_dir: toOptionalString(boltzRaw.cache_dir ?? boltzRaw.cacheDir ?? record.boltzCacheDir),
      use_msa_server:
        typeof (boltzRaw.use_msa_server ?? boltzRaw.useMsaServer ?? record.boltzUseMsaServer) === 'boolean'
          ? Boolean(boltzRaw.use_msa_server ?? boltzRaw.useMsaServer ?? record.boltzUseMsaServer)
          : base.boltz.use_msa_server,
      worker: Math.max(
        1,
        Math.floor(
          toNumberOrDefault(
            boltzRaw.worker ?? boltzRaw.boltzWorker ?? record.boltzWorker,
            base.boltz.worker ?? 1
          )
        )
      ),
    },
    flashbind: {
      root:
        (flashbindRaw.root as string) ||
        (record.flashbindRoot as string) ||
        base.flashbind?.root ||
        DEFAULT_FLASHBIND_CONFIG.root,
      protein_id:
        (flashbindRaw.protein_id as string) ||
        (flashbindRaw.proteinId as string) ||
        (record.flashbindProteinId as string) ||
        base.flashbind?.protein_id ||
        DEFAULT_FLASHBIND_CONFIG.protein_id,
      pdb_dir:
        (flashbindRaw.pdb_dir as string) ||
        (flashbindRaw.pdbDir as string) ||
        (record.flashbindPdbDir as string) ||
        base.flashbind?.pdb_dir ||
        DEFAULT_FLASHBIND_CONFIG.pdb_dir,
      protein_repr:
        (flashbindRaw.protein_repr as string) ||
        (flashbindRaw.proteinRepr as string) ||
        (record.flashbindProteinRepr as string) ||
        base.flashbind?.protein_repr ||
        DEFAULT_FLASHBIND_CONFIG.protein_repr,
      ligand_repr:
        (flashbindRaw.ligand_repr as string) ||
        (flashbindRaw.ligandRepr as string) ||
        (record.flashbindLigandRepr as string) ||
        base.flashbind?.ligand_repr ||
        DEFAULT_FLASHBIND_CONFIG.ligand_repr,
      prots_json: toOptionalString(
        flashbindRaw.prots_json ??
          flashbindRaw.protsJson ??
          record.flashbindProtsJson ??
          base.flashbind?.prots_json
      ),
      fabind_checkpoint:
        (flashbindRaw.fabind_checkpoint as string) ||
        (flashbindRaw.fabindCheckpoint as string) ||
        (record.flashbindFabindCheckpoint as string) ||
        base.flashbind?.fabind_checkpoint ||
        DEFAULT_FLASHBIND_CONFIG.fabind_checkpoint,
      binary_checkpoints: toStringArray(
        flashbindRaw.binary_checkpoints ??
          flashbindRaw.binaryCheckpoints ??
          record.flashbindBinaryCheckpoints,
        base.flashbind?.binary_checkpoints ?? DEFAULT_FLASHBIND_CONFIG.binary_checkpoints
      ),
      value_checkpoints: toStringArray(
        flashbindRaw.value_checkpoints ??
          flashbindRaw.valueCheckpoints ??
          record.flashbindValueCheckpoints,
        base.flashbind?.value_checkpoints ?? DEFAULT_FLASHBIND_CONFIG.value_checkpoints
      ),
      fabind_conda_env:
        (flashbindRaw.fabind_conda_env as string) ||
        (flashbindRaw.fabindCondaEnv as string) ||
        (record.flashbindFabindCondaEnv as string) ||
        base.flashbind?.fabind_conda_env ||
        DEFAULT_FLASHBIND_CONFIG.fabind_conda_env,
      flashbind_conda_env:
        (flashbindRaw.flashbind_conda_env as string) ||
        (flashbindRaw.flashbindCondaEnv as string) ||
        (record.flashbindFlashbindCondaEnv as string) ||
        base.flashbind?.flashbind_conda_env ||
        DEFAULT_FLASHBIND_CONFIG.flashbind_conda_env,
      fabind_num_threads: Math.max(
        1,
        Math.floor(
          toNumberOrDefault(
            flashbindRaw.fabind_num_threads ??
              flashbindRaw.fabindNumThreads ??
              record.flashbindFabindNumThreads,
            base.flashbind?.fabind_num_threads ?? DEFAULT_FLASHBIND_CONFIG.fabind_num_threads
          )
        )
      ),
      fabind_batch_size: Math.max(
        1,
        Math.floor(
          toNumberOrDefault(
            flashbindRaw.fabind_batch_size ??
              flashbindRaw.fabindBatchSize ??
              record.flashbindFabindBatchSize,
            base.flashbind?.fabind_batch_size ?? DEFAULT_FLASHBIND_CONFIG.fabind_batch_size
          )
        )
      ),
      fabind_post_optim:
        typeof (
          flashbindRaw.fabind_post_optim ??
          flashbindRaw.fabindPostOptim ??
          record.flashbindFabindPostOptim
        ) === 'boolean'
          ? Boolean(
              flashbindRaw.fabind_post_optim ??
                flashbindRaw.fabindPostOptim ??
                record.flashbindFabindPostOptim
            )
          : base.flashbind?.fabind_post_optim ?? DEFAULT_FLASHBIND_CONFIG.fabind_post_optim,
      devices: Math.max(
        1,
        Math.floor(
          toNumberOrDefault(
            flashbindRaw.devices ?? record.flashbindDevices,
            base.flashbind?.devices ?? DEFAULT_FLASHBIND_CONFIG.devices
          )
        )
      ),
      accelerator:
        (flashbindRaw.accelerator as string) ||
        (record.flashbindAccelerator as string) ||
        base.flashbind?.accelerator ||
        DEFAULT_FLASHBIND_CONFIG.accelerator,
      num_workers: Math.max(
        1,
        Math.floor(
          toNumberOrDefault(
            flashbindRaw.num_workers ?? flashbindRaw.numWorkers ?? record.flashbindNumWorkers,
            base.flashbind?.num_workers ?? DEFAULT_FLASHBIND_CONFIG.num_workers
          )
        )
      ),
      distance_threshold: toNumberOrDefault(
        flashbindRaw.distance_threshold ??
          flashbindRaw.distanceThreshold ??
          record.flashbindDistanceThreshold,
        base.flashbind?.distance_threshold ?? DEFAULT_FLASHBIND_CONFIG.distance_threshold
      ),
      repr_n_jobs: Math.floor(
        toNumberOrDefault(
          flashbindRaw.repr_n_jobs ?? flashbindRaw.reprNJobs ?? record.flashbindReprNJobs,
          base.flashbind?.repr_n_jobs ?? DEFAULT_FLASHBIND_CONFIG.repr_n_jobs
        )
      ),
      auto_generate_protein_repr:
        typeof (
          flashbindRaw.auto_generate_protein_repr ??
          flashbindRaw.autoGenerateProteinRepr ??
          record.flashbindAutoGenerateProteinRepr
        ) === 'boolean'
          ? Boolean(
              flashbindRaw.auto_generate_protein_repr ??
                flashbindRaw.autoGenerateProteinRepr ??
                record.flashbindAutoGenerateProteinRepr
            )
          : base.flashbind?.auto_generate_protein_repr ??
            DEFAULT_FLASHBIND_CONFIG.auto_generate_protein_repr,
      auto_generate_ligand_repr:
        typeof (
          flashbindRaw.auto_generate_ligand_repr ??
          flashbindRaw.autoGenerateLigandRepr ??
          record.flashbindAutoGenerateLigandRepr
        ) === 'boolean'
          ? Boolean(
              flashbindRaw.auto_generate_ligand_repr ??
                flashbindRaw.autoGenerateLigandRepr ??
                record.flashbindAutoGenerateLigandRepr
            )
          : base.flashbind?.auto_generate_ligand_repr ??
            DEFAULT_FLASHBIND_CONFIG.auto_generate_ligand_repr,
      reward_cache_path: toOptionalString(
        flashbindRaw.reward_cache_path ??
          flashbindRaw.rewardCachePath ??
          record.flashbindRewardCachePath ??
          base.flashbind?.reward_cache_path
      ),
      hf_cache: toOptionalString(
        flashbindRaw.hf_cache ??
          flashbindRaw.hfCache ??
          flashbindRaw.hf_hub_cache ??
          record.flashbindHfCache ??
          base.flashbind?.hf_cache
      ),
    },
  };

  const parsed = OptConfigSchema.safeParse(normalized);
  return parsed.success ? parsed.data : base;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    validateFilePath(filePath, 'read');
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function isProcessAlive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTail(filePath: string, lines = 500): Promise<string[]> {
  try {
    validateFilePath(filePath, 'read');
    const content = await fs.readFile(filePath, 'utf-8');
    const all = content.split('\n');
    return all.slice(-lines).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    validateFilePath(targetPath, 'read');
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listSubdirectories(parentDir: string): Promise<string[]> {
  try {
    validateFilePath(parentDir, 'read');
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findFirstMatchingFile(
  rootDir: string,
  predicate: (name: string) => boolean,
  maxDepth = 5
): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    let entries: any[];
    try {
      validateFilePath(item.dir, 'read');
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(item.dir, entry.name);
      if (entry.isFile() && predicate(entry.name)) {
        return fullPath;
      }
      if (entry.isDirectory() && item.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: item.depth + 1 });
      }
    }
  }

  return null;
}

const AMINO_ACID_3_TO_1: Record<string, string> = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLN: 'Q',
  GLU: 'E',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
  SEC: 'U',
  PYL: 'O',
  MSE: 'M',
};

interface ParsedProteinSequence {
  chainId: string;
  sequence: string;
}

function parseProteinSequencesFromPdb(pdbContent: string): ParsedProteinSequence[] {
  const chainResidues = new Map<string, { order: string[]; residues: Map<string, string> }>();

  for (const line of pdbContent.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue;
    if (line.length < 27) continue;

    const residueName = line.slice(17, 20).trim().toUpperCase();
    const chainRaw = line.slice(21, 22).trim();
    const chainId = chainRaw || 'A';
    const residueNumber = line.slice(22, 26).trim();
    const insertionCode = line.slice(26, 27).trim();
    const residueKey = `${residueNumber}:${insertionCode}`;

    const oneLetter = AMINO_ACID_3_TO_1[residueName];
    if (!oneLetter) continue;

    let chain = chainResidues.get(chainId);
    if (!chain) {
      chain = { order: [], residues: new Map<string, string>() };
      chainResidues.set(chainId, chain);
    }
    if (!chain.residues.has(residueKey)) {
      chain.order.push(residueKey);
      chain.residues.set(residueKey, oneLetter);
    }
  }

  const sequences: ParsedProteinSequence[] = [];
  for (const [chainId, chain] of chainResidues.entries()) {
    const sequence = chain.order.map((key) => chain.residues.get(key) ?? '').join('');
    if (sequence.length > 0) {
      sequences.push({ chainId, sequence });
    }
  }
  return sequences;
}

async function generateBoltzBaseYamlFromPdb(
  pdbPath: string,
  outputPath: string,
  msaPath?: string | null
): Promise<void> {
  validateFilePath(pdbPath, 'read');
  const pdbContent = await fs.readFile(pdbPath, 'utf-8');
  const sequences = parseProteinSequencesFromPdb(pdbContent);
  if (sequences.length === 0) {
    throw new Error(`Could not extract protein sequence from PDB: ${pdbPath}`);
  }

  const yamlPayload = {
    version: 1,
    sequences: sequences.map((entry) => ({
      protein: {
        id: entry.chainId,
        sequence: entry.sequence,
        ...(msaPath ? { msa: msaPath } : {}),
      },
    })),
  };
  await fs.writeFile(outputPath, YAML.stringify(yamlPayload), 'utf-8');
}

interface ArtifactMolecule {
  smiles: string;
  reward: number;
  oracleIdx: number;
  molIdx: number;
  boltzScores: BoltzScore | null;
}

function normalizeReward(affinity: number | null, probability: number | null): number {
  if (affinity == null || probability == null) return 0;
  if (!Number.isFinite(affinity) || !Number.isFinite(probability)) return 0;
  return ((-affinity + 2.0) / 4.0) * probability;
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function getBoltzMetricRowsFromRunDir(resultDir: string): Promise<BoltzMetricInputRow[]> {
  const trainDir = path.join(resultDir, 'train');
  validateFilePath(trainDir, 'read');
  let boltzFiles: string[] = [];
  try {
    const entries = await fs.readdir(trainDir);
    boltzFiles = entries
      .filter((name) => name.startsWith('boltz_scores_') && name.endsWith('.db'))
      .sort();
  } catch {
    boltzFiles = [];
  }

  const metricRows: BoltzMetricInputRow[] = [];
  for (const boltzFile of boltzFiles) {
    const boltzDbPath = path.join(trainDir, boltzFile);
    try {
      const boltzDb = await openDatabase(boltzDbPath);
      const rows = queryAll<{
        iteration: number;
        smiles: string;
        affinity_model1: number | null;
        probability_model1: number | null;
      }>(
        boltzDb,
        `SELECT iteration, smiles, affinity_model1, probability_model1
         FROM results
         ORDER BY iteration ASC, rowid ASC`
      );
      boltzDb.close();
      metricRows.push(
        ...rows.map((row) => ({
          iteration: Number(row.iteration ?? 0),
          smiles: row.smiles,
          affinityModel1: row.affinity_model1 ?? null,
          probabilityModel1: row.probability_model1 ?? null,
        }))
      );
    } catch {
      // Continue scanning other shards while files are being written.
    }
  }

  if (metricRows.length > 0) {
    metricRows.sort((a, b) => a.iteration - b.iteration || a.smiles.localeCompare(b.smiles));
    return metricRows;
  }

  const artifactRows = await loadMoleculesFromArtifacts(resultDir, Number.MAX_SAFE_INTEGER);
  return artifactRows
    .map((row) => ({
      iteration: row.boltzScores?.iteration ?? row.oracleIdx ?? 0,
      smiles: row.smiles,
      affinityModel1: row.boltzScores?.affinity_model1 ?? null,
      probabilityModel1: row.boltzScores?.probability_model1 ?? null,
    }))
    .sort((a, b) => a.iteration - b.iteration || a.smiles.localeCompare(b.smiles));
}

async function readRunProgressFromLog(resultDir: string): Promise<{ currentStep: number; totalSteps: number }> {
  const logPath = path.join(resultDir, 'train.log');
  try {
    validateFilePath(logPath, 'read');
    const content = await fs.readFile(logPath, 'utf-8');
    const matches = content.matchAll(/iteration\s+(\d+)/gi);
    let maxIteration = 0;
    for (const match of matches) {
      const parsed = Number.parseInt(match[1] ?? '0', 10);
      if (parsed > maxIteration) maxIteration = parsed;
    }
    return { currentStep: maxIteration, totalSteps: maxIteration };
  } catch {
    return { currentStep: 0, totalSteps: 0 };
  }
}

async function getLatestCheckpoint(resultDir: string): Promise<string | null> {
  try {
    validateFilePath(resultDir, 'read');
    const files = await fs.readdir(resultDir);
    const checkpoints = files
      .filter((file) => file.startsWith('model_state_') && file.endsWith('.pt'))
      .sort();
    if (checkpoints.length === 0) return null;
    const latest = checkpoints[checkpoints.length - 1];
    return latest ? path.join(resultDir, latest) : null;
  } catch {
    return null;
  }
}

async function loadMoleculesFromArtifacts(resultDir: string, limit: number): Promise<MoleculeResult[]> {
  const boltzRoot = path.join(resultDir, 'boltz_cofold');
  const oracleDirs = await listSubdirectories(boltzRoot);
  if (oracleDirs.length === 0) return [];

  const parsedRows: ArtifactMolecule[] = [];

  for (const oracleDir of oracleDirs) {
    const oracleMatch = oracleDir.match(/^oracle(\d+)$/);
    if (!oracleMatch?.[1]) continue;
    const oracleIdx = Number.parseInt(oracleMatch[1], 10);
    if (!Number.isFinite(oracleIdx)) continue;

    const oraclePath = path.join(boltzRoot, oracleDir);
    const molDirs = await listSubdirectories(oraclePath);
    for (const molDir of molDirs) {
      const molMatch = molDir.match(/^mol_(\d+)$/);
      if (!molMatch?.[1]) continue;
      const molIdx = Number.parseInt(molMatch[1], 10);
      if (!Number.isFinite(molIdx)) continue;

      const molPath = path.join(oraclePath, molDir);
      const yamlPath = path.join(molPath, `mol_${molIdx}.yaml`);
      let smiles = '';
      if (await pathExists(yamlPath)) {
        try {
          validateFilePath(yamlPath, 'read');
          const yamlContent = await fs.readFile(yamlPath, 'utf-8');
          const parsedYaml = YAML.parse(yamlContent) as any;
          const sequences = Array.isArray(parsedYaml?.sequences) ? parsedYaml.sequences : [];
          const ligandEntry = sequences.find(
            (entry: any) => entry && typeof entry === 'object' && entry.ligand?.smiles
          );
          smiles = ligandEntry?.ligand?.smiles ?? '';
        } catch {
          smiles = '';
        }
      }
      if (!smiles) continue;

      const predictionBase = path.join(
        molPath,
        'boltz_output',
        `boltz_results_mol_${molIdx}`,
        'predictions',
        `mol_${molIdx}`
      );
      const affinityPath = path.join(predictionBase, `affinity_mol_${molIdx}.json`);

      let affinityModel1: number | null = null;
      let probabilityModel1: number | null = null;
      let affinityEnsemble: number | null = null;
      let probabilityEnsemble: number | null = null;
      let affinityModel2: number | null = null;
      let probabilityModel2: number | null = null;
      if (await pathExists(affinityPath)) {
        try {
          validateFilePath(affinityPath, 'read');
          const affinityRaw = await fs.readFile(affinityPath, 'utf-8');
          const affinity = JSON.parse(affinityRaw) as Record<string, unknown>;
          affinityEnsemble = toFiniteOrNull(affinity.affinity_pred_value);
          probabilityEnsemble = toFiniteOrNull(affinity.affinity_probability_binary);
          affinityModel1 = toFiniteOrNull(affinity.affinity_pred_value1) ?? affinityEnsemble;
          probabilityModel1 = toFiniteOrNull(affinity.affinity_probability_binary1) ?? probabilityEnsemble;
          affinityModel2 = toFiniteOrNull(affinity.affinity_pred_value2);
          probabilityModel2 = toFiniteOrNull(affinity.affinity_probability_binary2);
        } catch {
          // Keep nulls
        }
      }

      const reward = normalizeReward(affinityModel1, probabilityModel1);
      parsedRows.push({
        smiles,
        reward,
        oracleIdx,
        molIdx,
        boltzScores:
          affinityModel1 != null || probabilityModel1 != null
            ? {
                iteration: oracleIdx,
                smiles,
                docking_score: 0,
                affinity_ensemble: affinityEnsemble ?? 0,
                probability_ensemble: probabilityEnsemble ?? 0,
                affinity_model1: affinityModel1 ?? 0,
                probability_model1: probabilityModel1 ?? 0,
                affinity_model2: affinityModel2 ?? 0,
                probability_model2: probabilityModel2 ?? 0,
              }
            : null,
      });
    }
  }

  parsedRows.sort((a, b) => b.reward - a.reward);
  return parsedRows.slice(0, limit).map((row) => ({
    smiles: row.smiles,
    reward: row.reward,
    trajectory: [],
    boltzScores: row.boltzScores,
    complexPath: null,
    oracleIdx: row.oracleIdx,
    molIdx: row.molIdx,
  }));
}

// ============================================================================
// Runner core
// ============================================================================

export async function startRunnerServer(options: RunnerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.dataDir ?? path.join(os.homedir(), '.cgflow-runner');
  const runsDir = path.join(dataDir, 'runs');
  const runsFile = path.join(dataDir, 'runs.json');
  const convexUrl = options.convexUrl ?? process.env.VITE_CONVEX_URL ?? process.env.CONVEX_URL;
  const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;
  const convexSync = getConvexSyncService(convexUrl);

  await ensureDir(runsDir);

  const state: RunnerState = {
    runs: new Map(),
    outputs: new Map(),
    processes: new Map(),
  };
  const artifactMapCache = new Map<string, Map<string, MoleculeResult>>();
  const resultDirRefreshTimers = new Map<string, NodeJS.Timeout>();
  const resultDirRefreshInFlight = new Set<string>();

  const sseClients = new Set<http.ServerResponse>();

  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  async function persistRuns() {
    const all = Array.from(state.runs.values());
    await writeJson(runsFile, { runs: all });
  }

  async function loadRuns() {
    const data = await readJson<{ runs: RunRecord[] }>(runsFile, { runs: [] });
    for (const run of data.runs) {
      const alive = isProcessAlive(run.pid);
      if (run.status === 'running' && !alive) {
        run.status = 'paused';
        run.error = 'Runner restarted; previous process not found.';
      }
      run.engine = normalizeEngine(run.engine);
      run.source = 'local';
      state.runs.set(run.id, run);
    }
  }

  await loadRuns();

  async function resolveConvexFile(convexPath: string, destDir: string): Promise<string> {
    if (!convexClient) {
      throw new Error('Convex not configured');
    }
    const parsed = parseConvexPath(convexPath);
    if (!parsed) throw new Error('Invalid Convex file path');
    const url = await convexClient.query(api.files.getUrl, { id: parsed.id as any });
    if (!url) throw new Error('Convex file URL not available');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const safeName = parsed.name ? parsed.name.replace(/[^a-zA-Z0-9._-]/g, '_') : 'file';
    const destPath = path.join(destDir, `${parsed.id}_${safeName}`);
    await fs.writeFile(destPath, buffer);
    return destPath;
  }

  async function resolveConfigPaths(config: OptConfig, inputsDir: string): Promise<OptConfig> {
    const resolved = JSON.parse(JSON.stringify(config)) as OptConfig;

    const resolveFile = async (value: string | null): Promise<string | null> => {
      if (!value) return null;
      if (isConvexPath(value)) {
        await ensureDir(inputsDir);
        return await resolveConvexFile(value, inputsDir);
      }
      return value;
    };

    resolved.protein_path = (await resolveFile(resolved.protein_path)) ?? '';
    resolved.ref_ligand_path = await resolveFile(resolved.ref_ligand_path);
    resolved.pose_model = (await resolveFile(resolved.pose_model)) ?? resolved.pose_model;
    resolved.boltz.msa_path = await resolveFile(resolved.boltz.msa_path);

    return resolved;
  }


  async function detectResultDir(baseDir: string, startedAt: number): Promise<string | null> {
    try {
    validateFilePath(baseDir, 'read');
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const dirs = entries
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => /^\d{6}_\d{6}$/.test(name))
        .map((name) => ({
          name,
          path: path.join(baseDir, name),
        }));

      let best: { name: string; path: string; mtimeMs: number } | null = null;
      for (const dir of dirs) {
      validateFilePath(dir.path, 'read');
        const stats = await fs.stat(dir.path);
        if (!best || stats.mtimeMs > best.mtimeMs) {
          best = { ...dir, mtimeMs: stats.mtimeMs };
        }
      }

      if (best && best.mtimeMs >= startedAt - 5000) {
        return best.path;
      }
    } catch {
      return null;
    }
    return null;
  }

  async function copyConfigToResultDir(configPath: string, resultDir: string) {
    try {
      await ensureDir(resultDir);
      const dest = path.join(resultDir, 'config.yaml');
      await fs.copyFile(configPath, dest);
    } catch {
      // ignore
    }
  }

  async function syncRunResultDir(
    runId: string,
    nextResultDir: string,
    sourceConfigPath?: string
  ): Promise<boolean> {
    const run = state.runs.get(runId);
    if (!run || !nextResultDir || run.resultDir === nextResultDir) {
      return false;
    }

    const oldResultDir = run.resultDir;
    run.resultDir = nextResultDir;
    run.lastUpdatedAt = new Date().toISOString();

    if (run.checkpointPath) {
      const checkpointName = path.basename(run.checkpointPath);
      if (checkpointName.startsWith('model_state_') && checkpointName.endsWith('.pt')) {
        run.checkpointPath = path.join(nextResultDir, checkpointName);
      }
    }

    artifactMapCache.delete(oldResultDir);
    artifactMapCache.delete(nextResultDir);
    if (sourceConfigPath) {
      await copyConfigToResultDir(sourceConfigPath, nextResultDir);
    }

    await persistRuns();
    broadcast('run:status-changed', run);
    if (run.convexRunId) {
      convexSync.stopSync(runId);
      convexSync.startSync(runId, run.convexRunId, nextResultDir, run.engine ?? 'boltz', 30000);
    }
    return true;
  }

  async function maybeRefreshRunResultDir(
    runId: string,
    baseDir: string,
    startedAt: number,
    sourceConfigPath?: string
  ): Promise<boolean> {
    const run = state.runs.get(runId);
    if (!run || run.status !== 'running') {
      return false;
    }
    const detected = await detectResultDir(baseDir, startedAt);
    if (!detected) {
      return false;
    }
    return await syncRunResultDir(runId, detected, sourceConfigPath);
  }

  function stopResultDirRefresh(runId: string) {
    const timer = resultDirRefreshTimers.get(runId);
    if (timer) {
      clearInterval(timer);
      resultDirRefreshTimers.delete(runId);
    }
    resultDirRefreshInFlight.delete(runId);
  }

  function startResultDirRefresh(
    runId: string,
    baseDir: string,
    startedAt: number,
    sourceConfigPath?: string
  ) {
    stopResultDirRefresh(runId);

    const tick = async () => {
      const run = state.runs.get(runId);
      if (!run || run.status !== 'running') {
        stopResultDirRefresh(runId);
        return;
      }
      if (resultDirRefreshInFlight.has(runId)) return;
      resultDirRefreshInFlight.add(runId);
      try {
        await maybeRefreshRunResultDir(runId, baseDir, startedAt, sourceConfigPath);
      } finally {
        resultDirRefreshInFlight.delete(runId);
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, RESULT_DIR_REFRESH_INTERVAL_MS);
    resultDirRefreshTimers.set(runId, timer);
    void tick();
  }

  async function startRun(payload: RunnerStartPayload): Promise<RunRecord> {
    const config = payload.config;
    const configName = payload.name;
    if (!config) {
      throw new Error('Config payload is required.');
    }

    const runId = generateRunId();
    const runStartedAt = Date.now();
    const timestamp = formatTimestamp(new Date(runStartedAt));
    const expectedResultDir = path.join(config.result_dir, timestamp);

    const runMetaDir = path.join(runsDir, runId);
    await ensureDir(runMetaDir);

    const engine = normalizeEngine(config.engine);
    const inputsDir = path.join(runMetaDir, 'inputs');
    const resolvedConfig = await resolveConfigPaths(config, inputsDir);
    await ensureDir(inputsDir);
    if (engine === 'boltz') {
      if (!resolvedConfig.protein_path) {
        throw new Error('protein_path is required to generate Boltz base YAML.');
      }
      const generatedBoltzYamlPath = path.join(inputsDir, 'boltz_base.generated.yaml');
      await generateBoltzBaseYamlFromPdb(
        resolvedConfig.protein_path,
        generatedBoltzYamlPath,
        resolvedConfig.boltz.msa_path
      );
      resolvedConfig.boltz.base_yaml = generatedBoltzYamlPath;
    }
    const resolvedConfigPath = path.join(runMetaDir, 'config.resolved.yaml');
    await fs.writeFile(resolvedConfigPath, YAML.stringify(resolvedConfig), 'utf-8');

    const logPath = path.join(runMetaDir, 'run.log');

    const runInfo: RunRecord = {
      id: runId,
      name: configName || `Run ${timestamp}`,
      configPath: payload.configPath ?? resolvedConfigPath,
      resultDir: expectedResultDir,
      status: 'running',
      currentStep: 0,
      totalSteps: config.num_steps,
      startedAt: new Date(runStartedAt).toISOString(),
      lastUpdatedAt: new Date(runStartedAt).toISOString(),
      checkpointPath: null,
      error: null,
      engine,
      pid: null,
      convexRunId: null,
      source: 'local',
      logPath,
    };

    state.runs.set(runId, runInfo);
    state.outputs.set(runId, []);
    await persistRuns();

    if (convexUrl) {
      const convexRunId = await convexSync.createRun(
        runInfo.name,
        runInfo.engine ?? 'boltz',
        runInfo.resultDir,
        runInfo.totalSteps
      );
      if (convexRunId) {
        runInfo.convexRunId = convexRunId;
        await persistRuns();
      }
    }

    const args = [
      getOptScriptForEngine(engine),
      '--config',
      resolvedConfigPath,
      '--result_dir',
      config.result_dir,
      '--env_dir',
      config.env_dir,
    ];

    const proc = spawnCgflowPython(args, {
      cwd: CGFLOW_ROOT,
      env: { ...process.env },
    });

    runInfo.pid = proc.pid ?? null;
    state.processes.set(runId, proc);

    let stdoutBuffer = '';
    const commandString = formatCondaCommand(args);

    const appendOutput = async (line: string) => {
      if (!line) return;
      const existing = state.outputs.get(runId) ?? [];
      existing.push(line);
      if (existing.length > 2000) {
        existing.splice(0, existing.length - 2000);
      }
      state.outputs.set(runId, existing);
      await fs.appendFile(logPath, `${line}\n`, 'utf-8');
      broadcast('run:output', { runId, output: line });
    };

    await appendOutput(`[runner] Launching command: ${commandString}`);

    const handleChunk = async (chunk: Buffer, label?: string) => {
      const text = chunk.toString();
      const combined = stdoutBuffer + text;
      const lines = combined.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const outLine = label ? `${label} ${line}` : line;
        await appendOutput(outLine);
        const stepMatch = line.match(/iteration\s+(\d+)/i);
        if (stepMatch?.[1]) {
          runInfo.currentStep = parseInt(stepMatch[1], 10);
          runInfo.lastUpdatedAt = new Date().toISOString();
          void persistRuns();
          broadcast('run:status-changed', runInfo);
        }
        const checkpointMatch = line.match(/Saved checkpoint.*?(model_state_\d+\.pt)/);
        if (checkpointMatch?.[1]) {
          runInfo.checkpointPath = path.join(runInfo.resultDir, checkpointMatch[1]);
          void persistRuns();
          broadcast('run:checkpoint-saved', { runId, checkpointPath: runInfo.checkpointPath });
        }
      }
    };

    proc.stdout?.on('data', (data: Buffer) => {
      void handleChunk(data);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      void handleChunk(data, '[stderr]');
    });

    proc.on('close', async (code, signal) => {
      stopResultDirRefresh(runId);
      runInfo.status = code === 0 ? 'completed' : 'error';
      runInfo.error =
        code === 0
          ? null
          : buildFailureMessage({
              code,
              signal,
              outputLines: state.outputs.get(runId) ?? [],
              logPath: runInfo.logPath,
              command: commandString,
            });
      runInfo.lastUpdatedAt = new Date().toISOString();
      state.processes.delete(runId);
      await persistRuns();
      if (code !== 0) {
        broadcast('run:error', { runId, error: runInfo.error ?? `Process exited with code ${code}` });
      }
      broadcast('run:status-changed', runInfo);

      if (runInfo.convexRunId) {
        await convexSync.updateRunStatus(
          runInfo.convexRunId,
          runInfo.status,
          runInfo.currentStep,
          runInfo.checkpointPath,
          runInfo.error
        );
        convexSync.stopSync(runId);
      }
    });

    proc.on('error', async (err) => {
      stopResultDirRefresh(runId);
      runInfo.status = 'error';
      runInfo.error = err.message;
      runInfo.lastUpdatedAt = new Date().toISOString();
      state.processes.delete(runId);
      await persistRuns();
      broadcast('run:error', { runId, error: err.message });
      broadcast('run:status-changed', runInfo);

      if (runInfo.convexRunId) {
        await convexSync.updateRunStatus(
          runInfo.convexRunId,
          'error',
          runInfo.currentStep,
          runInfo.checkpointPath,
          runInfo.error
        );
        convexSync.stopSync(runId);
      }
    });

    // Try to detect actual result directory and keep revalidating while running.
    for (let attempt = 0; attempt < RESULT_DIR_INITIAL_DETECTION_ATTEMPTS; attempt++) {
      const refreshed = await maybeRefreshRunResultDir(
        runId,
        config.result_dir,
        runStartedAt,
        resolvedConfigPath
      );
      if (refreshed) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RESULT_DIR_INITIAL_DETECTION_INTERVAL_MS));
    }
    startResultDirRefresh(runId, config.result_dir, runStartedAt, resolvedConfigPath);

    // Start Convex sync if configured
    if (runInfo.convexRunId) {
      convexSync.startSync(runId, runInfo.convexRunId, runInfo.resultDir, runInfo.engine ?? 'boltz', 30000);
    }

    broadcast('run:status-changed', runInfo);

    return runInfo;
  }

  async function resumeRun(runId: string, checkpointPath: string, oracleIdx?: number): Promise<RunRecord> {
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const args = [
      getOptScriptForEngine(normalizeEngine(run.engine)),
      '--config',
      run.configPath,
      '--resume_from',
      checkpointPath,
    ];
    if (oracleIdx !== undefined) {
      args.push('--resume_oracle_idx', String(oracleIdx));
    }

    const proc = spawnCgflowPython(args, {
      cwd: CGFLOW_ROOT,
      env: { ...process.env },
    });

    run.status = 'running';
    run.lastUpdatedAt = new Date().toISOString();
    run.checkpointPath = checkpointPath;
    run.resultDir = path.dirname(checkpointPath);
    run.pid = proc.pid ?? null;
    state.processes.set(runId, proc);
    await persistRuns();

    let stdoutBuffer = '';
    const commandString = formatCondaCommand(args);

    const appendOutput = async (line: string) => {
      if (!line) return;
      const existing = state.outputs.get(runId) ?? [];
      existing.push(line);
      if (existing.length > 2000) {
        existing.splice(0, existing.length - 2000);
      }
      state.outputs.set(runId, existing);
      if (run.logPath) {
        await fs.appendFile(run.logPath, `${line}\n`, 'utf-8');
      }
      broadcast('run:output', { runId, output: line });
    };

    await appendOutput(`[runner] Launching command: ${commandString}`);

    const handleChunk = async (chunk: Buffer, label?: string) => {
      const text = chunk.toString();
      const combined = stdoutBuffer + text;
      const lines = combined.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const outLine = label ? `${label} ${line}` : line;
        await appendOutput(outLine);
        const stepMatch = line.match(/iteration\s+(\d+)/i);
        if (stepMatch?.[1]) {
          run.currentStep = parseInt(stepMatch[1], 10);
          run.lastUpdatedAt = new Date().toISOString();
          void persistRuns();
          broadcast('run:status-changed', run);
        }
      }
    };

    proc.stdout?.on('data', (data: Buffer) => {
      void handleChunk(data);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      void handleChunk(data, '[stderr]');
    });

    proc.on('close', async (code, signal) => {
      stopResultDirRefresh(runId);
      run.status = code === 0 ? 'completed' : 'error';
      run.error =
        code === 0
          ? null
          : buildFailureMessage({
              code,
              signal,
              outputLines: state.outputs.get(runId) ?? [],
              logPath: run.logPath,
              command: commandString,
            });
      run.lastUpdatedAt = new Date().toISOString();
      state.processes.delete(runId);
      await persistRuns();
      if (code !== 0) {
        broadcast('run:error', { runId, error: run.error ?? `Process exited with code ${code}` });
      }
      broadcast('run:status-changed', run);

      if (run.convexRunId) {
        await convexSync.updateRunStatus(
          run.convexRunId,
          run.status,
          run.currentStep,
          run.checkpointPath,
          run.error
        );
        convexSync.stopSync(runId);
      }
    });

    proc.on('error', async (err) => {
      stopResultDirRefresh(runId);
      run.status = 'error';
      run.error = err.message;
      run.lastUpdatedAt = new Date().toISOString();
      state.processes.delete(runId);
      await persistRuns();
      broadcast('run:error', { runId, error: err.message });
      broadcast('run:status-changed', run);

      if (run.convexRunId) {
        await convexSync.updateRunStatus(
          run.convexRunId,
          'error',
          run.currentStep,
          run.checkpointPath,
          run.error
        );
        convexSync.stopSync(runId);
      }
    });

    if (run.convexRunId) {
      await convexSync.updateRunStatus(run.convexRunId, 'running', run.currentStep);
      convexSync.startSync(runId, run.convexRunId, run.resultDir, run.engine ?? 'boltz', 30000);
    }

    broadcast('run:status-changed', run);

    return run;
  }

  async function importExistingRun(resultDir: string, name?: string | null): Promise<RunRecord> {
    validateFilePath(resultDir, 'read');
    const stats = await fs.stat(resultDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`Result directory does not exist: ${resultDir}`);
    }

    const runId = generateRunId();
    const progress = await readRunProgressFromLog(resultDir);
    const checkpointPath = await getLatestCheckpoint(resultDir);
    const startedAt = new Date(stats.mtimeMs).toISOString();
    const configPathCandidate = path.join(resultDir, 'config.yaml');
    let importedConfig: OptConfig | null = null;
    if (await pathExists(configPathCandidate)) {
      try {
        validateFilePath(configPathCandidate, 'read');
        const configRaw = await fs.readFile(configPathCandidate, 'utf-8');
        importedConfig = normalizeImportedConfig(YAML.parse(configRaw), resultDir);
      } catch {
        importedConfig = null;
      }
    }

    const run: RunRecord = {
      id: runId,
      name: name?.trim() || `Imported ${path.basename(resultDir)}`,
      configPath: (await pathExists(configPathCandidate)) ? configPathCandidate : resultDir,
      resultDir,
      status: 'completed',
      currentStep: progress.currentStep,
      totalSteps: progress.totalSteps || importedConfig?.num_steps || progress.currentStep,
      startedAt,
      lastUpdatedAt: new Date().toISOString(),
      checkpointPath,
      error: null,
      engine: importedConfig?.engine ?? 'boltz',
      pid: null,
      convexRunId: null,
      source: 'local',
      logPath: path.join(resultDir, 'train.log'),
    };

    if (convexClient && convexUrl) {
      try {
        const convexRunId = await convexSync.createRun(
          run.name,
          run.engine ?? 'boltz',
          run.resultDir,
          run.totalSteps
        );

        if (convexRunId) {
          run.convexRunId = convexRunId;
          await convexSync.syncRun(run.id, convexRunId, run.resultDir, run.engine ?? 'boltz');
          await convexSync.updateRunStatus(
            convexRunId,
            run.status,
            run.currentStep,
            run.checkpointPath,
            run.error
          );
        }
      } catch (err) {
        console.error(`Failed to sync imported run ${run.id} to Convex:`, err);
      }
    }

    state.runs.set(run.id, run);
    await persistRuns();
    broadcast('run:status-changed', run);
    return run;
  }

  async function deleteRun(runId: string): Promise<void> {
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    if (state.processes.has(runId) || isProcessAlive(run.pid)) {
      throw new Error('Cannot delete a running run. Stop it first.');
    }

    convexSync.stopSync(runId);

    if (run.convexRunId && convexClient) {
      try {
        await convexClient.mutation(api.runs.remove, { id: run.convexRunId as any });
      } catch (err) {
        console.error(`Failed to delete cloud run for ${runId}:`, err);
      }
    }

    state.runs.delete(runId);
    state.outputs.delete(runId);
    state.processes.delete(runId);
    artifactMapCache.delete(run.resultDir);
    await persistRuns();
  }

  async function syncRunToCloud(runId: string): Promise<RunRecord> {
    const run = state.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    if (!convexClient || !convexUrl) {
      throw new Error('Convex is not configured. Set VITE_CONVEX_URL/CONVEX_URL to enable cloud sync.');
    }

    if (!run.convexRunId) {
      const convexRunId = await convexSync.createRun(
        run.name,
        run.engine ?? 'boltz',
        run.resultDir,
        run.totalSteps
      );
      if (!convexRunId) {
        throw new Error('Failed to create run in cloud.');
      }
      run.convexRunId = convexRunId;
    }

    await convexSync.syncRun(run.id, run.convexRunId, run.resultDir, run.engine ?? 'boltz');
    await convexSync.updateRunStatus(
      run.convexRunId,
      run.status,
      run.currentStep,
      run.checkpointPath,
      run.error
    );

    // Keep periodic sync active only for actively running runs.
    if (run.status === 'running') {
      convexSync.startSync(run.id, run.convexRunId, run.resultDir, run.engine ?? 'boltz', 30000);
    }

    run.lastUpdatedAt = new Date().toISOString();
    state.runs.set(run.id, run);
    await persistRuns();
    broadcast('run:status-changed', run);
    return run;
  }

  async function loadTrajectoryMap(trainDir: string, smiles: string[]): Promise<Map<string, string>> {
    const trajMap = new Map<string, string>();
    if (smiles.length === 0) return trajMap;

    let files: string[] = [];
    try {
      validateFilePath(trainDir, 'read');
      files = await fs.readdir(trainDir);
    } catch {
      return trajMap;
    }

    const dbFiles = files.filter((f) => f.startsWith('generated_objs_') && f.endsWith('.db'));
    if (dbFiles.length === 0) return trajMap;

    const placeholders = smiles.map(() => '?').join(',');

    for (const dbFile of dbFiles) {
      const dbPath = path.join(trainDir, dbFile);
      try {
        const genDb = await openDatabase(dbPath);
        const trajRows = queryAll<{ smi: string; traj: string }>(
          genDb,
          `SELECT smi, traj FROM results WHERE smi IN (${placeholders})`,
          smiles
        );
        genDb.close();
        for (const row of trajRows) {
          if (!row.traj) continue;
          const existing = trajMap.get(row.smi);
          if (!existing) {
            trajMap.set(row.smi, row.traj);
            continue;
          }
          try {
            const currentLen = JSON.parse(existing).length ?? 0;
            const nextLen = JSON.parse(row.traj).length ?? 0;
            if (nextLen > currentLen) {
              trajMap.set(row.smi, row.traj);
            }
          } catch {
            // Keep existing on parse error
          }
        }
      } catch {
        // Ignore missing/corrupt DB files
      }
    }

    return trajMap;
  }

  async function getTopMolecules(runId: string, limit = 50): Promise<MoleculeResult[]> {
    const run = state.runs.get(runId);
    if (!run) return [];
    const runEngine = normalizeEngine(run.engine);
    if (runEngine === 'flashbind') {
      return await getFlashbindTopMolecules(run.resultDir, limit, {
        openDatabase,
        queryAll,
        pathExists,
      });
    }

    const rewardCachePath = path.join(run.resultDir, 'boltz_reward_cache.db');
    const trainDir = path.join(run.resultDir, 'train');

    const results: MoleculeResult[] = [];

    try {
      const rewardDb = await openDatabase(rewardCachePath);
      const topEntries = queryAll<RewardCacheEntry>(
        rewardDb,
        `SELECT smiles, reward, info FROM entries ORDER BY reward DESC LIMIT ?`,
        [limit]
      );
      rewardDb.close();

      if (topEntries.length === 0) {
        return await loadMoleculesFromArtifacts(run.resultDir, limit);
      }

      // Get trajectory info (scan all generated_objs_*.db)
      const trajMap = await loadTrajectoryMap(
        trainDir,
        topEntries.map((e) => e.smiles)
      );

      // Get boltz scores
      const boltzDbPath = path.join(trainDir, 'boltz_scores_0.db');
      let boltzMap = new Map<string, BoltzScore>();

      try {
        const boltzDb = await openDatabase(boltzDbPath);
        const placeholders = topEntries.map(() => '?').join(',');
        const boltzRows = queryAll<BoltzScore>(
          boltzDb,
          `SELECT * FROM results WHERE smiles IN (${placeholders})`,
          topEntries.map((e) => e.smiles)
        );
        boltzDb.close();
        boltzMap = new Map(boltzRows.map((r) => [r.smiles, r]));
      } catch {
        // Boltz scores DB may not exist yet
      }

      const indexMap = new Map<string, { oracleIdx: number | null; molIdx: number | null }>();
      for (const entry of topEntries) {
        if (!entry.info) continue;
        try {
          const parsed = JSON.parse(entry.info) as { oracle_idx?: number; mol_idx?: number };
          indexMap.set(entry.smiles, {
            oracleIdx: typeof parsed.oracle_idx === 'number' ? parsed.oracle_idx : null,
            molIdx: typeof parsed.mol_idx === 'number' ? parsed.mol_idx : null,
          });
        } catch {
          // ignore
        }
      }

      for (const entry of topEntries) {
        const trajStr = trajMap.get(entry.smiles);
        let trajectory: TrajectoryStep[] = [];

        if (trajStr) {
          try {
            trajectory = JSON.parse(trajStr) as TrajectoryStep[];
          } catch {
            // Invalid trajectory JSON
          }
        }

        const idx = indexMap.get(entry.smiles);

        results.push({
          smiles: entry.smiles,
          reward: entry.reward,
          trajectory,
          boltzScores: boltzMap.get(entry.smiles) ?? null,
          complexPath: null,
          oracleIdx: idx?.oracleIdx ?? null,
          molIdx: idx?.molIdx ?? null,
        });
      }
    } catch {
      return await loadMoleculesFromArtifacts(run.resultDir, limit);
    }

    if (results.length === 0) {
      return await loadMoleculesFromArtifacts(run.resultDir, limit);
    }

    const needsArtifactLookup = results.some(
      (row) => row.oracleIdx == null || row.molIdx == null || row.boltzScores == null
    );
    if (needsArtifactLookup) {
      const shouldUseArtifactCache = run.status !== 'running';
      let artifactMap = shouldUseArtifactCache ? artifactMapCache.get(run.resultDir) : undefined;
      if (!artifactMap) {
        const artifactRows = await loadMoleculesFromArtifacts(run.resultDir, Number.MAX_SAFE_INTEGER);
        artifactMap = new Map(artifactRows.map((row) => [row.smiles, row]));
        if (shouldUseArtifactCache) {
          artifactMapCache.set(run.resultDir, artifactMap);
        }
      }

      for (const row of results) {
        const artifact = artifactMap.get(row.smiles);
        if (!artifact) continue;
        if (row.oracleIdx == null && artifact.oracleIdx != null) {
          row.oracleIdx = artifact.oracleIdx;
        }
        if (row.molIdx == null && artifact.molIdx != null) {
          row.molIdx = artifact.molIdx;
        }
        if (row.boltzScores == null && artifact.boltzScores) {
          row.boltzScores = artifact.boltzScores;
          if (!Number.isFinite(row.reward) || row.reward === 0) {
            row.reward = artifact.reward;
          }
        }
      }
    }
    return results;
  }

  async function getBoltzMetrics(runId: string): Promise<BoltzMetricSeries | null> {
    const run = state.runs.get(runId);
    if (!run) return null;
    const runEngine = normalizeEngine(run.engine);
    const rows =
      runEngine === 'flashbind'
        ? await getFlashbindMetricRowsFromRunDir(run.resultDir, {
            openDatabase,
            queryAll,
            pathExists,
          })
        : await getBoltzMetricRowsFromRunDir(run.resultDir);
    if (rows.length === 0) return null;
    return computeBoltzMetrics(rows);
  }

  async function getComplexContent(runId: string, oracleIdx: number, molIdx: number): Promise<string | null> {
    const run = state.runs.get(runId);
    if (!run) return null;
    const runEngine = normalizeEngine(run.engine);
    if (runEngine === 'flashbind') {
      return await getFlashbindComplexContent(run.resultDir, oracleIdx, molIdx);
    }
    const basePath = path.join(
      run.resultDir,
      'boltz_cofold',
      `oracle${oracleIdx}`,
      `mol_${molIdx}`,
      'boltz_output'
    );
    if (!isPathContained(basePath, [run.resultDir])) {
      return null;
    }
    validateFilePath(basePath, 'read');
    try {
      const structurePath = await findFirstMatchingFile(
        basePath,
        (name) => name.endsWith('.cif') || name.endsWith('.pdb'),
        6
      );
      if (structurePath) {
        if (!isPathContained(structurePath, [run.resultDir])) {
          return null;
        }
        validateFilePath(structurePath, 'read');
        return await fs.readFile(structurePath, 'utf-8');
      }
    } catch {
      return null;
    }
    return null;
  }

  function normalizedPdbPathFor(filePath: string): string {
    const parsedPath = path.parse(filePath);
    const extension = parsedPath.ext || '.pdb';
    return path.join(parsedPath.dir, `${parsedPath.name}.1indexed${extension}`);
  }

  async function readTextFileAtPath(filePath: string): Promise<string> {
    const trimmedPath = filePath.trim();
    validateFilePath(trimmedPath, 'read');
    return await fs.readFile(trimmedPath, 'utf-8');
  }

  async function normalizePdbResiduesAtPath(filePath: string): Promise<NormalizedPdbFile> {
    const content = await readTextFileAtPath(filePath);
    const normalized = normalizePdbResiduesToOneIndexed(content);

    if (!normalized.converted) {
      return {
        path: filePath,
        content,
        converted: false,
        message: null,
      };
    }

    const normalizedPath = normalizedPdbPathFor(filePath);
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, normalized.content, 'utf-8');

    return {
      path: normalizedPath,
      content: normalized.content,
      converted: true,
      message: normalized.message,
    };
  }

  // ========================================================================
  // HTTP server
  // ========================================================================

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const isDev = process.env.NODE_ENV === 'development';
    const requestOrigin = req.headers.origin;
    if (isDev && requestOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/').filter(Boolean);

    const sendJson = (code: number, payload: unknown) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    const sendText = (code: number, payload: string) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'text/plain');
      res.end(payload);
    };

    const readBody = async () => {
      return await new Promise<string>((resolve) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => resolve(body));
      });
    };

    const readJsonBody = async (): Promise<unknown> => {
      const body = await readBody();
      if (!body.trim()) return {};
      try {
        return JSON.parse(body);
      } catch {
        throw new Error('Invalid JSON body');
      }
    };

    const parseIntegerQueryParam = (
      paramName: string,
      options: { min?: number; max?: number } = {}
    ): { value: number | null; valid: boolean } => {
      const raw = url.searchParams.get(paramName);
      if (raw == null) return { value: null, valid: true };
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed)) return { value: null, valid: false };
      if (options.min != null && parsed < options.min) return { value: null, valid: false };
      if (options.max != null && parsed > options.max) return { value: null, valid: false };
      return { value: parsed, valid: true };
    };

    if (req.method === 'POST' && url.pathname === '/files/read-text') {
      let rawPayload: unknown;
      try {
        rawPayload = await readJsonBody();
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid request body' });
        return;
      }
      const parsedPayload = RunnerFilePathPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        sendJson(400, {
          error: 'Invalid file path payload',
          details: parsedPayload.error.issues,
        });
        return;
      }
      try {
        const content = await readTextFileAtPath(parsedPayload.data.path);
        sendJson(200, { content });
      } catch (err) {
        sendText(404, err instanceof Error ? err.message : 'Failed to read file');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/files/normalize-pdb-residues') {
      let rawPayload: unknown;
      try {
        rawPayload = await readJsonBody();
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid request body' });
        return;
      }
      const parsedPayload = RunnerFilePathPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        sendJson(400, {
          error: 'Invalid file path payload',
          details: parsedPayload.error.issues,
        });
        return;
      }
      try {
        const normalized = await normalizePdbResiduesAtPath(parsedPayload.data.path);
        sendJson(200, normalized);
      } catch (err) {
        sendText(404, err instanceof Error ? err.message : 'Failed to normalize PDB');
      }
      return;
    }

    // Health
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(200, {
        status: 'ok',
        version: '0.1.0',
        runs: state.runs.size,
      });
      return;
    }

    // SSE events
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // Runs
    if (req.method === 'GET' && url.pathname === '/runs') {
      sendJson(200, Array.from(state.runs.values()));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/runs') {
      let rawPayload: unknown;
      try {
        rawPayload = await readJsonBody();
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid request body' });
        return;
      }
      const parsedPayload = RunnerStartPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        sendJson(400, {
          error: 'Invalid start payload',
          details: parsedPayload.error.issues,
        });
        return;
      }
      try {
        if (parsedPayload.data.config) {
          validateFilePath(parsedPayload.data.config.result_dir, 'write');
          validateFilePath(parsedPayload.data.config.env_dir, 'read');
        }
        const run = await startRun(parsedPayload.data as RunnerStartPayload);
        sendJson(200, run);
      } catch (err) {
        sendText(500, err instanceof Error ? err.message : 'Failed to start run');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/runs/import') {
      let rawPayload: unknown;
      try {
        rawPayload = await readJsonBody();
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid request body' });
        return;
      }
      const parsedPayload = RunnerImportPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        sendJson(400, {
          error: 'Invalid import payload',
          details: parsedPayload.error.issues,
        });
        return;
      }
      try {
        validateFilePath(parsedPayload.data.resultDir, 'read');
        const run = await importExistingRun(parsedPayload.data.resultDir, parsedPayload.data.name);
        sendJson(200, run);
      } catch (err) {
        sendText(500, err instanceof Error ? err.message : 'Failed to import run');
      }
      return;
    }

    if (pathParts[0] === 'runs' && pathParts[1]) {
      const runId = pathParts[1];

      if (req.method === 'GET' && pathParts.length === 2) {
        const run = state.runs.get(runId);
        if (!run) {
          sendJson(404, { error: 'Run not found' });
          return;
        }
        sendJson(200, run);
        return;
      }

      if (req.method === 'DELETE' && pathParts.length === 2) {
        try {
          await deleteRun(runId);
          sendJson(200, { ok: true });
        } catch (err) {
          sendText(400, err instanceof Error ? err.message : 'Failed to delete run');
        }
        return;
      }

      if (req.method === 'POST' && pathParts[2] === 'stop') {
        const run = state.runs.get(runId);
        if (!run) {
          sendJson(404, { error: 'Run not found' });
          return;
        }
        const proc = state.processes.get(runId);
        if (proc) {
          proc.kill('SIGINT');
          stopResultDirRefresh(runId);
          run.status = 'paused';
          run.lastUpdatedAt = new Date().toISOString();
          await persistRuns();
          broadcast('run:status-changed', run);
          if (run.convexRunId) {
            await convexSync.updateRunStatus(run.convexRunId, 'paused', run.currentStep, run.checkpointPath);
            convexSync.stopSync(runId);
          }
        }
        sendJson(200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathParts[2] === 'resume') {
        let rawPayload: unknown;
        try {
          rawPayload = await readJsonBody();
        } catch (err) {
          sendJson(400, { error: err instanceof Error ? err.message : 'Invalid request body' });
          return;
        }
        const parsedPayload = RunnerResumePayloadSchema.safeParse(rawPayload);
        if (!parsedPayload.success) {
          sendJson(400, {
            error: 'Invalid resume payload',
            details: parsedPayload.error.issues,
          });
          return;
        }
        try {
          const runForValidation = state.runs.get(runId);
          if (!runForValidation) {
            sendJson(404, { error: 'Run not found' });
            return;
          }
          validateFilePath(parsedPayload.data.checkpointPath, 'read');
          if (!isPathContained(parsedPayload.data.checkpointPath, [runForValidation.resultDir])) {
            sendJson(400, { error: 'checkpointPath must be inside the run result directory' });
            return;
          }
          const run = await resumeRun(
            runId,
            parsedPayload.data.checkpointPath,
            parsedPayload.data.oracleIdx
          );
          sendJson(200, run);
        } catch (err) {
          sendText(500, err instanceof Error ? err.message : 'Failed to resume run');
        }
        return;
      }

      if (req.method === 'POST' && pathParts[2] === 'delete') {
        try {
          await deleteRun(runId);
          sendJson(200, { ok: true });
        } catch (err) {
          sendText(500, err instanceof Error ? err.message : 'Failed to delete run');
        }
        return;
      }

      if (req.method === 'POST' && pathParts[2] === 'sync-cloud') {
        try {
          const run = await syncRunToCloud(runId);
          sendJson(200, run);
        } catch (err) {
          sendText(500, err instanceof Error ? err.message : 'Failed to sync run to cloud');
        }
        return;
      }

      if (req.method === 'GET' && pathParts[2] === 'checkpoints') {
        const run = state.runs.get(runId);
        if (!run) {
          sendJson(404, { error: 'Run not found' });
          return;
        }
        try {
          validateFilePath(run.resultDir, 'read');
          const files = await fs.readdir(run.resultDir);
          const checkpoints = files
            .filter((f) => f.startsWith('model_state_') && f.endsWith('.pt'))
            .map((f) => path.join(run.resultDir, f))
            .sort();
          sendJson(200, checkpoints);
        } catch {
          sendJson(200, []);
        }
        return;
      }

      if (req.method === 'GET' && pathParts[2] === 'output') {
        const run = state.runs.get(runId);
        if (!run) {
          sendJson(404, { error: 'Run not found' });
          return;
        }
        const tailQuery = parseIntegerQueryParam('tail', { min: 1, max: 50000 });
        if (!tailQuery.valid) {
          sendJson(400, { error: 'Invalid tail parameter' });
          return;
        }
        const tail = tailQuery.value ?? 500;
        const lines = run.logPath ? await readTail(run.logPath, tail) : [];
        sendJson(200, { lines });
        return;
      }

      if (req.method === 'GET' && pathParts[2] === 'molecules') {
        const limitQuery = parseIntegerQueryParam('limit', { min: 1, max: 10000 });
        if (!limitQuery.valid) {
          sendJson(400, { error: 'Invalid limit parameter' });
          return;
        }
        const limit = limitQuery.value ?? 50;
        const molecules = await getTopMolecules(runId, limit);
        sendJson(200, molecules);
        return;
      }

      if (req.method === 'GET' && pathParts[2] === 'boltz-metrics') {
        const metrics = await getBoltzMetrics(runId);
        if (!metrics) {
          sendJson(404, { error: 'Boltz metrics not found' });
          return;
        }
        sendJson(200, metrics);
        return;
      }

      if (req.method === 'GET' && pathParts[2] === 'complex') {
        const oracleIdxQuery = parseIntegerQueryParam('oracleIdx', { min: 0 });
        const molIdxQuery = parseIntegerQueryParam('molIdx', { min: 0 });
        if (!oracleIdxQuery.valid || !molIdxQuery.valid || oracleIdxQuery.value == null || molIdxQuery.value == null) {
          sendJson(400, { error: 'Missing oracleIdx or molIdx' });
          return;
        }
        const oracleIdx = oracleIdxQuery.value;
        const molIdx = molIdxQuery.value;
        const content = await getComplexContent(runId, oracleIdx, molIdx);
        if (!content) {
          sendJson(404, { error: 'Complex not found' });
          return;
        }
        sendText(200, content);
        return;
      }
    }

    sendJson(404, { error: 'Not found' });
  });

  const { owned } = await listenRunnerServer(server, port);
  if (owned) {
    registerRunnerShutdown({
      server,
      processes: state.processes,
      sseClients,
      stopResultDirRefresh,
    });
  }
}

// CLI mode
const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(entry)) {
  void (async () => {
    await loadDotEnvIfPresent();
    await startRunnerServer(parseRunnerOptionsFromEnv());
  })().catch((err) => {
    console.error('Failed to start runner:', err);
    process.exit(1);
  });
}
