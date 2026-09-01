import { z } from 'zod';

const SENSITIVE_PATH_PREFIXES = ['/etc', '/proc'] as const;

function hasSensitivePathPrefix(value: string): boolean {
  return SENSITIVE_PATH_PREFIXES.some(
    (prefix) => value === prefix || value.startsWith(`${prefix}/`)
  );
}

function isSafePathString(value: string): boolean {
  if (value.includes('\0')) return false;
  if (value.includes('..')) return false;
  if (/[\x01-\x1f\x7f]/.test(value)) return false;
  const normalized = value.replace(/\\/g, '/').trim();
  if (hasSensitivePathPrefix(normalized)) return false;
  return true;
}

export const safePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isSafePathString, {
    message: 'Invalid or unsafe path',
  });

/** Path field that may be blank in the UI and filled in by the runner at start time. */
const emptyOrSafePathSchema = z
  .string()
  .max(4096)
  .refine((value) => value === '' || isSafePathString(value), {
    message: 'Invalid or unsafe path',
  });

const nullableSafePathSchema = safePathSchema.nullable();

export const positiveInt = z.number().int().min(1).max(100_000);
export const portNumber = z.number().int().min(1).max(65535);
export const tailLines = z.number().int().min(1).max(10_000);
export const runnerIndex = z.number().int().min(0).max(1_000_000_000);
export const runnerLimit = z.number().int().min(1).max(10_000);
export const configNameSchema = z.string().trim().min(1).max(255);

const targetResidueSchema = z.string().regex(/^[A-Z]:\d+$/, {
  message: 'target_residues must match CHAIN:RESID (e.g. A:123)',
});

// ============================================================================
// Config Schema (matches NS5_crop_boltz.yaml structure)
// ============================================================================

export const OptimizationEngineSchema = z.enum(['boltz', 'flashbind']);

export const BoltzConfigSchema = z.object({
  base_yaml: emptyOrSafePathSchema.default(''),
  target_residues: z.array(targetResidueSchema),
  msa_path: nullableSafePathSchema,
  cache_dir: nullableSafePathSchema,
  use_msa_server: z.boolean(),
  worker: z.number().int().min(1).max(1024).optional().default(1),
});

export const FlashBindConfigSchema = z.object({
  root: safePathSchema,
  protein_id: z.string(),
  pdb_dir: safePathSchema,
  protein_repr: safePathSchema,
  ligand_repr: safePathSchema,
  prots_json: nullableSafePathSchema,
  fabind_checkpoint: safePathSchema,
  binary_checkpoints: z.array(safePathSchema),
  value_checkpoints: z.array(safePathSchema),
  fabind_conda_env: z.string(),
  flashbind_conda_env: z.string(),
  fabind_num_threads: z.number().int().min(1).max(256),
  fabind_batch_size: z.number().int().min(1).max(4096),
  fabind_post_optim: z.boolean(),
  devices: z.number().int().min(1).max(64),
  accelerator: z.string(),
  num_workers: z.number().int().min(1).max(1024),
  distance_threshold: z.number().min(0).max(1000),
  repr_n_jobs: z.number().int().min(-1).max(1024),
  auto_generate_protein_repr: z.boolean(),
  auto_generate_ligand_repr: z.boolean(),
  reward_cache_path: nullableSafePathSchema,
  hf_cache: nullableSafePathSchema,
});

const BaseOptConfigSchema = z.object({
  result_dir: safePathSchema,
  env_dir: safePathSchema,
  max_atoms: z.number().int().min(1).max(100_000),
  subsampling_ratio: z.number().min(0).max(1),
  protein_path: safePathSchema,
  center: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  ref_ligand_path: nullableSafePathSchema,
  size: z.tuple([z.number(), z.number(), z.number()]),
  num_steps: z.number().int().min(1).max(100_000),
  num_sampling_per_step: z.number().int().min(1).max(100_000),
  temperature: z.tuple([z.number(), z.number()]),
  seed: z.number().int().min(0).max(2_147_483_647),
  pose_model: safePathSchema,
  pose_steps: z.number().int().min(1).max(100_000),
  sampling_tau: z.number().min(0).max(100),
  random_action_prob: z.number().min(0).max(1),
  replay_warmup_step: z.number().int().min(0).max(100_000),
  replay_capacity: z.number().int().min(1).max(1_000_000),
});

const BoltzOptConfigSchema = BaseOptConfigSchema.extend({
  engine: z.literal('boltz'),
  boltz: BoltzConfigSchema,
  // Retained in the UI when switching engines; not validated for Boltz runs.
  flashbind: z.unknown().optional(),
});

const FlashBindOptConfigSchema = BaseOptConfigSchema.extend({
  engine: z.literal('flashbind'),
  boltz: BoltzConfigSchema,
  flashbind: FlashBindConfigSchema,
});

function normalizeOptConfigEngine(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const raw = input as Record<string, unknown>;
  if (raw.engine === 'flashbind') {
    return raw;
  }

  return { ...raw, engine: 'boltz' };
}

export const OptConfigSchema = z.preprocess(
  normalizeOptConfigEngine,
  z.discriminatedUnion('engine', [BoltzOptConfigSchema, FlashBindOptConfigSchema])
);

export type OptimizationEngine = z.infer<typeof OptimizationEngineSchema>;
export type BoltzConfig = z.infer<typeof BoltzConfigSchema>;
export type FlashBindConfig = z.infer<typeof FlashBindConfigSchema>;
export type OptConfig = z.infer<typeof OptConfigSchema>;

export interface NormalizedPdbFile {
  path: string;
  content: string;
  converted: boolean;
  message: string | null;
}

// ============================================================================
// Run Status and Management
// ============================================================================

export const RunStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'error',
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunInfoSchema = z.object({
  id: z.string(),
  name: configNameSchema,
  configPath: safePathSchema,
  resultDir: safePathSchema,
  status: RunStatusSchema,
  currentStep: z.number().int().min(0).max(100_000),
  totalSteps: z.number().int().min(0).max(100_000),
  startedAt: z.string().nullable(),
  lastUpdatedAt: z.string().nullable(),
  checkpointPath: nullableSafePathSchema,
  error: z.string().nullable(),
  engine: OptimizationEngineSchema.optional(),
  convexRunId: z.string().nullable().optional(),
  source: z.enum(['local', 'convex']).optional(),
});

export type RunInfo = z.infer<typeof RunInfoSchema>;

// ============================================================================
// Database Schemas (from SQLite)
// ============================================================================

export const GeneratedObjectSchema = z.object({
  smi: z.string(),
  r: z.number(),
  traj: z.string(),
});

export type GeneratedObject = z.infer<typeof GeneratedObjectSchema>;

export const BoltzScoreSchema = z.object({
  iteration: z.number(),
  smiles: z.string(),
  docking_score: z.number(),
  affinity_ensemble: z.number(),
  probability_ensemble: z.number(),
  affinity_model1: z.number(),
  probability_model1: z.number(),
  affinity_model2: z.number(),
  probability_model2: z.number(),
});

export type BoltzScore = z.infer<typeof BoltzScoreSchema>;

export const NormalizedScoreSchema = z.object({
  affinity: z.number(),
  probability: z.number(),
  score: z.number(),
});

export type NormalizedScore = z.infer<typeof NormalizedScoreSchema>;

export interface BoltzMetricInputRow {
  iteration: number;
  smiles: string;
  affinityModel1: number | null;
  probabilityModel1: number | null;
}

export interface BoltzMetricSeries {
  pointCount: number;
  bestProb: number[];
  top10AvgProb: number[];
  top100AvgProb: number[];
  thresholdCounts: Record<string, number[]>;
  thresholds: number[];
}

export const RewardCacheEntrySchema = z.object({
  smiles: z.string(),
  reward: z.number(),
  info: z.string().nullable(),
});

export type RewardCacheEntry = z.infer<typeof RewardCacheEntrySchema>;

// ============================================================================
// Trajectory / Reaction Pathway
// ============================================================================

export const TrajectoryStepSchema = z.object({
  step: z.number(),
  smiles: z.string(),
  action: z.tuple([z.string(), z.string(), z.string()]),
});

export type TrajectoryStep = z.infer<typeof TrajectoryStepSchema>;

// ============================================================================
// Molecule Result (for visualization)
// ============================================================================

export const MoleculeResultSchema = z.object({
  smiles: z.string(),
  reward: z.number(),
  trajectory: z.array(TrajectoryStepSchema),
  boltzScores: BoltzScoreSchema.nullable(),
  normalizedScores: NormalizedScoreSchema.nullable().optional(),
  complexPath: nullableSafePathSchema,
  engine: OptimizationEngineSchema.optional(),
  oracleIdx: runnerIndex.nullable().optional(),
  molIdx: runnerIndex.nullable().optional(),
});

export type MoleculeResult = z.infer<typeof MoleculeResultSchema>;

// ============================================================================
// Runner API payload/query schemas
// ============================================================================

export const RunnerStartPayloadSchema = z.object({
  config: OptConfigSchema.optional(),
  configPath: nullableSafePathSchema.optional(),
  name: configNameSchema.nullable().optional(),
});

export const RunnerResumePayloadSchema = z.object({
  checkpointPath: safePathSchema,
  oracleIdx: runnerIndex.optional(),
});

export const RunnerImportPayloadSchema = z.object({
  resultDir: safePathSchema,
  name: configNameSchema.nullable().optional(),
});

export const RunnerFilePathPayloadSchema = z.object({
  path: safePathSchema,
});

export const NormalizedPdbFileSchema = z.object({
  path: safePathSchema,
  content: z.string(),
  converted: z.boolean(),
  message: z.string().nullable(),
});

// ============================================================================
// IPC Channel Definitions
// ============================================================================

export interface IpcChannels {
  'file:select-pdb': () => Promise<string | null>;
  'file:select-ligand': () => Promise<string | null>;
  'file:select-json': () => Promise<string | null>;
  'file:select-msa': () => Promise<string | null>;
  'file:select-yaml': () => Promise<string | null>;
  'file:select-directory': () => Promise<string | null>;
  'file:read-pdb': (path: string) => Promise<string>;
  'file:read-text': (path: string) => Promise<string>;
  'file:normalize-pdb-residues': (path: string) => Promise<NormalizedPdbFile>;
  'file:read-yaml': (path: string) => Promise<OptConfig>;
  'file:write-yaml': (path: string, config: OptConfig) => Promise<void>;
  'file:exists': (path: string) => Promise<boolean>;

  'run:start': (payload: {
    config: OptConfig;
    configPath?: string | null;
    name?: string | null;
  }) => Promise<RunInfo>;
  'run:stop': (runId: string) => Promise<void>;
  'run:resume': (runId: string, checkpointPath: string, oracleIdx?: number) => Promise<RunInfo>;
  'run:get-status': (runId: string) => Promise<RunInfo | null>;
  'run:list': () => Promise<RunInfo[]>;
  'run:delete': (runId: string) => Promise<void>;
  'run:get-checkpoints': (runId: string) => Promise<string[]>;
  'run:get-output': (runId: string, tail?: number) => Promise<string[]>;
  'run:import-existing': (resultDir: string, name?: string | null) => Promise<RunInfo>;
  'run:sync-to-cloud': (runId: string) => Promise<RunInfo>;
  'run:get-boltz-metrics': (runId: string) => Promise<BoltzMetricSeries | null>;

  'db:get-generated-objects': (dbPath: string, limit?: number, offset?: number) => Promise<GeneratedObject[]>;
  'db:get-boltz-scores': (dbPath: string, limit?: number, offset?: number) => Promise<BoltzScore[]>;
  'db:get-reward-cache': (dbPath: string, limit?: number) => Promise<RewardCacheEntry[]>;
  'db:get-top-molecules': (runId: string, limit?: number) => Promise<MoleculeResult[]>;

  'boltz:get-complex': (runId: string, oracleIdx: number, molIdx: number) => Promise<string | null>;
  'boltz:get-complex-path': (runId: string, oracleIdx: number, molIdx: number) => Promise<string | null>;
  'boltz:read-complex': (complexPath: string) => Promise<string>;
}

export type IpcInvoke = <K extends keyof IpcChannels>(
  channel: K,
  ...args: Parameters<IpcChannels[K]>
) => ReturnType<IpcChannels[K]>;

// ============================================================================
// Events (main -> renderer)
// ============================================================================

export interface IpcEvents {
  'run:output': (runId: string, output: string) => void;
  'run:status-changed': (runInfo: RunInfo) => void;
  'run:checkpoint-saved': (runId: string, checkpointPath: string) => void;
  'run:error': (runId: string, error: string) => void;
}

export type IpcOn = <K extends keyof IpcEvents>(
  channel: K,
  callback: IpcEvents[K]
) => () => void;
