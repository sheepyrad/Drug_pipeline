import { z } from 'zod';
import {
  MoleculeResultSchema,
  NormalizedPdbFileSchema,
  RunInfoSchema,
  type BoltzMetricSeries,
  type MoleculeResult,
  type NormalizedPdbFile,
  type OptConfig,
  type RunInfo,
} from '@shared/types';

const DEFAULT_RUNNER_URL =
  import.meta.env.VITE_RUNNER_URL || 'http://127.0.0.1:45731';

export type RunnerHealth = {
  ok: boolean;
  reachable: boolean;
  status?: string;
  version?: string;
  runs?: number;
  error?: string;
};

export function getRunnerUrl(): string {
  return DEFAULT_RUNNER_URL;
}

const HealthResponseSchema = z.object({
  status: z.string(),
  version: z.string().optional(),
  runs: z.number().optional(),
});

type RunnerStartPayload = {
  config: OptConfig;
  configPath?: string | null;
  name?: string | null;
};

type RunnerEventName = 'run:output' | 'run:status-changed' | 'run:checkpoint-saved' | 'run:error';

type RunnerEventMap = {
  'run:output': { runId: string; output: string };
  'run:status-changed': RunInfo;
  'run:checkpoint-saved': { runId: string; checkpointPath: string };
  'run:error': { runId: string; error: string };
};

const RunnerOutputEventSchema = z.object({
  runId: z.string(),
  output: z.string(),
});
const RunnerCheckpointSavedEventSchema = z.object({
  runId: z.string(),
  checkpointPath: z.string(),
});
const RunnerErrorEventSchema = z.object({
  runId: z.string(),
  error: z.string(),
});
const RunnerEventSchemaMap = {
  'run:output': RunnerOutputEventSchema,
  'run:status-changed': RunInfoSchema,
  'run:checkpoint-saved': RunnerCheckpointSavedEventSchema,
  'run:error': RunnerErrorEventSchema,
} as const;

const OutputResponseSchema = z.object({ lines: z.array(z.string()) });
const ReadTextResponseSchema = z.object({ content: z.string() });
const BoltzMetricSeriesSchema = z.object({
  pointCount: z.number(),
  bestProb: z.array(z.number()),
  top10AvgProb: z.array(z.number()),
  top100AvgProb: z.array(z.number()),
  thresholds: z.array(z.number()),
  thresholdCounts: z.record(z.array(z.number())),
});

async function parseJsonResponse<T>(res: Response, schema: z.ZodSchema<T>, label: string): Promise<T> {
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response`);
  }
  return parsed.data;
}

class RunnerClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Map<RunnerEventName, Set<(data: any) => void>>();
  private lastHealthCheck = 0;
  private lastHealthOk = false;

  constructor(baseUrl = DEFAULT_RUNNER_URL) {
    this.baseUrl = baseUrl;
  }

  async isAvailable(force = false): Promise<boolean> {
    const health = await this.checkHealth(force);
    return health.ok;
  }

  async checkHealth(force = false): Promise<RunnerHealth> {
    const now = Date.now();
    if (!force && now - this.lastHealthCheck < 5000) {
      if (this.lastHealthOk) {
        return { ok: true, reachable: true };
      }
      return {
        ok: false,
        reachable: false,
        error: 'Runner is unavailable.',
      };
    }

    this.lastHealthCheck = now;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: 'GET' });
      if (!res.ok) {
        this.lastHealthOk = false;
        return {
          ok: false,
          reachable: true,
          error: `Runner health check failed with status ${res.status}.`,
        };
      }

      const data = await parseJsonResponse(res, HealthResponseSchema, 'health');
      const ok = data.status === 'ok';
      this.lastHealthOk = ok;
      return {
        ok,
        reachable: true,
        status: data.status,
        version: data.version,
        runs: data.runs,
        error: ok ? undefined : `Runner reported status "${data.status}".`,
      };
    } catch (error) {
      this.lastHealthOk = false;
      return {
        ok: false,
        reachable: false,
        error: error instanceof Error ? error.message : 'Failed to reach runner.',
      };
    }
  }

  async listRuns(): Promise<RunInfo[]> {
    const res = await fetch(`${this.baseUrl}/runs`);
    if (!res.ok) throw new Error('Failed to list runs');
    return await parseJsonResponse(res, z.array(RunInfoSchema), 'list runs');
  }

  async getRun(runId: string): Promise<RunInfo | null> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to get run');
    return await parseJsonResponse(res, RunInfoSchema, 'get run');
  }

  async startRun(payload: RunnerStartPayload): Promise<RunInfo> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to start run');
    }
    return await parseJsonResponse(res, RunInfoSchema, 'start run');
  }

  async stopRun(runId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to stop run');
  }

  async resumeRun(runId: string, checkpointPath: string, oracleIdx?: number): Promise<RunInfo> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpointPath, oracleIdx }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to resume run');
    }
    return await parseJsonResponse(res, RunInfoSchema, 'resume run');
  }

  async getCheckpoints(runId: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/checkpoints`);
    if (!res.ok) throw new Error('Failed to get checkpoints');
    return await parseJsonResponse(res, z.array(z.string()), 'checkpoints');
  }

  async getOutput(runId: string, tail = 500): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/output?tail=${tail}`);
    if (!res.ok) throw new Error('Failed to get output');
    const data = await parseJsonResponse(res, OutputResponseSchema, 'output');
    return data.lines;
  }

  async deleteRun(runId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to delete run');
    }
  }

  async getTopMolecules(runId: string, limit?: number): Promise<MoleculeResult[]> {
    const query = typeof limit === 'number' ? `?limit=${limit}` : '';
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/molecules${query}`);
    if (!res.ok) throw new Error('Failed to get molecules');
    return await parseJsonResponse(res, z.array(MoleculeResultSchema), 'molecules');
  }

  async getComplex(runId: string, oracleIdx: number, molIdx: number): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/complex?oracleIdx=${oracleIdx}&molIdx=${molIdx}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to get complex');
    return await res.text();
  }

  async importExistingRun(resultDir: string, name?: string | null): Promise<RunInfo> {
    const res = await fetch(`${this.baseUrl}/runs/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultDir, name: name ?? null }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to import run');
    }
    return await parseJsonResponse(res, RunInfoSchema, 'import run');
  }

  async syncRunToCloud(runId: string): Promise<RunInfo> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/sync-cloud`, {
      method: 'POST',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to sync run to cloud');
    }
    return await parseJsonResponse(res, RunInfoSchema, 'sync run');
  }

  async getBoltzMetrics(runId: string): Promise<BoltzMetricSeries | null> {
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/boltz-metrics`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to get boltz metrics');
    return await parseJsonResponse(res, BoltzMetricSeriesSchema, 'boltz metrics');
  }

  async readTextFile(filePath: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/files/read-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to read file');
    }
    const data = await parseJsonResponse(res, ReadTextResponseSchema, 'read text file');
    return data.content;
  }

  async normalizePdbResidues(filePath: string): Promise<NormalizedPdbFile> {
    const res = await fetch(`${this.baseUrl}/files/normalize-pdb-residues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to normalize PDB residues');
    }
    return await parseJsonResponse(res, NormalizedPdbFileSchema, 'normalize pdb residues');
  }

  on<K extends RunnerEventName>(event: K, handler: (data: RunnerEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as any);
    this.ensureEventSource();

    return () => {
      const handlers = this.listeners.get(event);
      if (handlers) {
        handlers.delete(handler as any);
      }
    };
  }

  private ensureEventSource() {
    if (this.eventSource) return;
    this.eventSource = new EventSource(`${this.baseUrl}/events`);

    const forward = <K extends RunnerEventName>(event: K) => (e: MessageEvent) => {
      try {
        const parsedData: unknown = JSON.parse(e.data);
        const parsedEvent = RunnerEventSchemaMap[event].safeParse(parsedData);
        if (!parsedEvent.success) {
          console.warn('Invalid runner event payload', event, parsedEvent.error.issues);
          return;
        }
        const handlers = this.listeners.get(event);
        if (handlers) {
          for (const h of handlers) h(parsedEvent.data as RunnerEventMap[K]);
        }
      } catch (err) {
        console.warn('Failed to parse runner event', event, err);
      }
    };

    this.eventSource.addEventListener('run:output', forward('run:output'));
    this.eventSource.addEventListener('run:status-changed', forward('run:status-changed'));
    this.eventSource.addEventListener('run:checkpoint-saved', forward('run:checkpoint-saved'));
    this.eventSource.addEventListener('run:error', forward('run:error'));

    this.eventSource.onerror = () => {
      // Allow reconnect on next subscription
      this.eventSource?.close();
      this.eventSource = null;
    };
  }
}

export const runnerClient = new RunnerClient();
