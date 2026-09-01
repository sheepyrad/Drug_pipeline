import { ConvexHttpClient } from 'convex/browser';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs/promises';
import YAML from 'yaml';
import type {
  BoltzScore,
  RewardCacheEntry,
} from '../shared/types';
import { api } from '../convex/_generated/api';

// Initialize SQL.js
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

async function openDatabase(dbPath: string): Promise<SqlJsDatabase> {
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listSubdirectories(parentDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function normalizeReward(affinity: number | null, probability: number | null): number {
  if (affinity == null || probability == null) return 0;
  if (!Number.isFinite(affinity) || !Number.isFinite(probability)) return 0;
  return ((-affinity + 2.0) / 4.0) * probability;
}

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function loadTrajectoryMap(trainDir: string, smiles: string[]): Promise<Map<string, string>> {
  const trajMap = new Map<string, string>();
  if (smiles.length === 0) return trajMap;

  let files: string[] = [];
  try {
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

async function loadArtifactMolecules(resultDir: string, limit: number) {
  const boltzRoot = path.join(resultDir, 'boltz_cofold');
  const oracleDirs = await listSubdirectories(boltzRoot);
  if (oracleDirs.length === 0) return [];

  const rows: Array<{
    smiles: string;
    reward: number;
    affinityEnsemble: number | null;
    probabilityEnsemble: number | null;
    affinityModel1: number | null;
    probabilityModel1: number | null;
    affinityModel2: number | null;
    probabilityModel2: number | null;
    oracleIdx: number | null;
    molIdx: number | null;
    iteration: number;
  }> = [];

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

      const yamlPath = path.join(oraclePath, molDir, `mol_${molIdx}.yaml`);
      if (!(await pathExists(yamlPath))) continue;

      let smiles = '';
      try {
        const yamlRaw = await fs.readFile(yamlPath, 'utf-8');
        const parsed = YAML.parse(yamlRaw) as any;
        const sequences = Array.isArray(parsed?.sequences) ? parsed.sequences : [];
        const ligand = sequences.find((entry: any) => entry?.ligand?.smiles);
        smiles = ligand?.ligand?.smiles ?? '';
      } catch {
        smiles = '';
      }
      if (!smiles) continue;

      const predictionBase = path.join(
        oraclePath,
        molDir,
        'boltz_output',
        `boltz_results_mol_${molIdx}`,
        'predictions',
        `mol_${molIdx}`
      );
      const affinityPath = path.join(predictionBase, `affinity_mol_${molIdx}.json`);

      let affinityEnsemble: number | null = null;
      let probabilityEnsemble: number | null = null;
      let affinityModel1: number | null = null;
      let probabilityModel1: number | null = null;
      let affinityModel2: number | null = null;
      let probabilityModel2: number | null = null;

      if (await pathExists(affinityPath)) {
        try {
          const raw = await fs.readFile(affinityPath, 'utf-8');
          const affinity = JSON.parse(raw) as Record<string, unknown>;
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

      rows.push({
        smiles,
        reward: normalizeReward(affinityModel1, probabilityModel1),
        affinityEnsemble,
        probabilityEnsemble,
        affinityModel1,
        probabilityModel1,
        affinityModel2,
        probabilityModel2,
        oracleIdx,
        molIdx,
        iteration: oracleIdx,
      });
    }
  }

  rows.sort((a, b) => b.reward - a.reward);
  return rows.slice(0, limit);
}

/**
 * Service to sync local SQLite data to Convex for cross-machine access.
 * 
 * This runs in the Electron main process and periodically uploads
 * new molecules, scores, and run metadata to Convex.
 */
export class ConvexSyncService {
  private client: ConvexHttpClient | null = null;
  private syncIntervals = new Map<string, NodeJS.Timeout>();
  private lastSyncTimestamp = new Map<string, number>();

  constructor(convexUrl?: string) {
    if (convexUrl) {
      this.client = new ConvexHttpClient(convexUrl);
    }
  }

  /**
   * Start periodic sync for a run
   */
  startSync(
    runId: string,
    convexRunId: string,
    resultDir: string,
    engine: 'boltz' | 'flashbind' = 'boltz',
    intervalMs = 30000
  ) {
    if (!this.client) {
      console.warn('Convex not configured, sync disabled');
      return;
    }

    // Stop any existing sync for this run
    this.stopSync(runId);

    // Initial sync
    this.syncRun(runId, convexRunId, resultDir, engine);

    // Set up periodic sync
    const interval = setInterval(() => {
      this.syncRun(runId, convexRunId, resultDir, engine);
    }, intervalMs);
    this.syncIntervals.set(runId, interval);
  }

  /**
   * Stop sync for a run
   */
  stopSync(runId: string) {
    const interval = this.syncIntervals.get(runId);
    if (interval) {
      clearInterval(interval);
      this.syncIntervals.delete(runId);
    }
  }

  /**
   * Sync a single run's data to Convex
   */
  async syncRun(
    runId: string,
    convexRunId: string,
    resultDir: string,
    engine: 'boltz' | 'flashbind' = 'boltz'
  ) {
    if (!this.client) return;

    try {
      // Sync molecules from reward cache
      await this.syncMolecules(convexRunId, resultDir, engine);

      // Sync run status
      await this.syncRunStatus(convexRunId, resultDir);

      this.lastSyncTimestamp.set(runId, Date.now());
    } catch (err) {
      console.error(`Failed to sync run ${runId}:`, err);
    }
  }

  /**
   * Create a run record in Convex and return its id.
   */
  async createRun(
    name: string,
    engine: 'boltz' | 'flashbind',
    resultDir: string,
    totalSteps: number
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const runId = await this.client.mutation(api.runs.create, {
        name,
        engine,
        resultDir,
        totalSteps,
      });
      // Mark as running immediately
      await this.client.mutation(api.runs.updateStatus, {
        id: runId as any,
        status: 'running',
      });
      return runId as any;
    } catch (err) {
      console.error('Failed to create Convex run:', err);
      return null;
    }
  }

  /**
   * Update run status in Convex
   */
  async updateRunStatus(
    convexRunId: string,
    status: 'idle' | 'running' | 'paused' | 'completed' | 'error',
    currentStep?: number,
    checkpointPath?: string | null,
    error?: string | null
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.mutation(api.runs.updateStatus, {
        id: convexRunId as any,
        status,
        currentStep,
        checkpointPath: checkpointPath ?? undefined,
        error: error ?? undefined,
      });
    } catch (err) {
      console.error('Failed to update Convex run status:', err);
    }
  }

  /**
   * Sync molecules from local SQLite to Convex
   */
  private async syncMolecules(
    convexRunId: string,
    resultDir: string,
    engine: 'boltz' | 'flashbind',
    limit = 1000
  ) {
    if (!this.client) return;

    const rewardCachePath = path.join(resultDir, 'boltz_reward_cache.db');
    const trainDir = path.join(resultDir, 'train');

    let molecules: Array<{
      runId: any;
      engine: 'boltz' | 'flashbind';
      smiles: string;
      reward: number;
      normalizedAffinity: number | null;
      normalizedProbability: number | null;
      normalizedScore: number | null;
      trajectory: string;
      affinityEnsemble: number | null;
      probabilityEnsemble: number | null;
      affinityModel1: number | null;
      probabilityModel1: number | null;
      affinityModel2: number | null;
      probabilityModel2: number | null;
      oracleIdx: number | null;
      molIdx: number | null;
      complexFileId: null;
      iteration: number;
    }> = [];

    if (await pathExists(rewardCachePath)) {
      const rewardDb = await openDatabase(rewardCachePath);
      const entries = queryAll<RewardCacheEntry>(
        rewardDb,
        `SELECT smiles, reward, info FROM entries ORDER BY reward DESC LIMIT ?`,
        [limit]
      );
      rewardDb.close();

      if (entries.length > 0) {
        const trajMap = await loadTrajectoryMap(
          trainDir,
          entries.map((e) => e.smiles)
        );

        let boltzMap = new Map<string, BoltzScore>();
        const boltzDbPath = path.join(trainDir, 'boltz_scores_0.db');
        try {
          const boltzDb = await openDatabase(boltzDbPath);
          const placeholders = entries.map(() => '?').join(',');
          const boltzRows = queryAll<BoltzScore>(
            boltzDb,
            `SELECT * FROM results WHERE smiles IN (${placeholders})`,
            entries.map((e) => e.smiles)
          );
          boltzDb.close();
          boltzMap = new Map(boltzRows.map((r) => [r.smiles, r]));
        } catch {
          // DB may not exist yet
        }

        const indexMap = new Map<string, { oracleIdx: number | null; molIdx: number | null }>();
        for (const entry of entries) {
          if (!entry.info) continue;
          try {
            const parsed = JSON.parse(entry.info) as { oracle_idx?: number; mol_idx?: number };
            indexMap.set(entry.smiles, {
              oracleIdx: typeof parsed.oracle_idx === 'number' ? parsed.oracle_idx : null,
              molIdx: typeof parsed.mol_idx === 'number' ? parsed.mol_idx : null,
            });
          } catch {
            // Ignore malformed JSON
          }
        }

        molecules = entries.map((entry) => {
          const boltz = boltzMap.get(entry.smiles);
          const idx = indexMap.get(entry.smiles);
          return {
            runId: convexRunId as any,
            engine,
            smiles: entry.smiles,
            reward: entry.reward,
            normalizedAffinity: null,
            normalizedProbability: null,
            normalizedScore: null,
            trajectory: trajMap.get(entry.smiles) || '[]',
            affinityEnsemble: boltz?.affinity_ensemble ?? null,
            probabilityEnsemble: boltz?.probability_ensemble ?? null,
            affinityModel1: boltz?.affinity_model1 ?? null,
            probabilityModel1: boltz?.probability_model1 ?? null,
            affinityModel2: boltz?.affinity_model2 ?? null,
            probabilityModel2: boltz?.probability_model2 ?? null,
            oracleIdx: idx?.oracleIdx ?? null,
            molIdx: idx?.molIdx ?? null,
            complexFileId: null,
            iteration: boltz?.iteration ?? 0,
          };
        });
      }
    }

    if (molecules.length === 0) {
      const artifactRows = await loadArtifactMolecules(resultDir, limit);
      molecules = artifactRows.map((row) => ({
        runId: convexRunId as any,
        engine,
        smiles: row.smiles,
        reward: row.reward,
        normalizedAffinity: null,
        normalizedProbability: null,
        normalizedScore: null,
        trajectory: '[]',
        affinityEnsemble: row.affinityEnsemble,
        probabilityEnsemble: row.probabilityEnsemble,
        affinityModel1: row.affinityModel1,
        probabilityModel1: row.probabilityModel1,
        affinityModel2: row.affinityModel2,
        probabilityModel2: row.probabilityModel2,
        oracleIdx: row.oracleIdx,
        molIdx: row.molIdx,
        complexFileId: null,
        iteration: row.iteration,
      }));
    }

    if (molecules.length === 0) return;

    // Batch upsert to Convex
    await this.client.mutation(api.molecules.batchUpsert, { molecules });
  }

  /**
   * Sync run status from train.log
   */
  private async syncRunStatus(convexRunId: string, resultDir: string) {
    if (!this.client) return;

    const logPath = path.join(resultDir, 'train.log');
    
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.split('\n');
      
      // Find last iteration
      let lastIteration = 0;
      for (const line of lines.reverse()) {
        const match = line.match(/iteration\s+(\d+)/i);
        if (match?.[1]) {
          lastIteration = parseInt(match[1], 10);
          break;
        }
      }

      // Update run status in Convex
      await this.client.mutation(api.runs.updateStatus, {
        id: convexRunId as any,
        status: 'running',
        currentStep: lastIteration,
      });
    } catch {
      // Log file may not exist yet
    }
  }

  /**
   * Upload a file to Convex storage
   */
  async uploadFile(
    filePath: string,
    fileType: 'pdb' | 'yaml' | 'msa' | 'db' | 'other',
    runId?: string
  ): Promise<string | null> {
    if (!this.client) return null;

    try {
      const content = await fs.readFile(filePath);
      const fileName = path.basename(filePath);

      // Get upload URL
      const uploadUrl = await this.client.mutation(api.files.generateUploadUrl, {});

      // Upload file
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      });
      const uploadResponse = (await response.json()) as { storageId: string };

      // Create file record
      const fileId = await this.client.mutation(api.files.create, {
        name: fileName,
        type: fileType,
        fieldType: 'other',
        storageId: uploadResponse.storageId as any,
        size: content.length,
        runId: (runId as any) || null,
      });

      return fileId as any;
    } catch (err) {
      console.error('Failed to upload file:', err);
      return null;
    }
  }
}

// Singleton instance
let syncService: ConvexSyncService | null = null;

export function getConvexSyncService(convexUrl?: string): ConvexSyncService {
  if (!syncService) {
    syncService = new ConvexSyncService(convexUrl);
  }
  return syncService;
}
