/**
 * Web fallback implementations for Electron IPC functions.
 * Used when running in browser without Electron.
 */

import type { IpcChannels, OptConfig, GeneratedObject, BoltzScore, RewardCacheEntry, MoleculeResult } from '@shared/types';
import { normalizePdbResiduesToOneIndexed } from '@shared/pdbResidues';

// Helper to create a file input and get selection
function selectFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Helper to read file as text
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// Store selected files in memory for web mode
const fileStore = new Map<string, { file: File; content: string }>();

// Web fallback implementations
export const webFallback: {
  [K in keyof IpcChannels]: (...args: Parameters<IpcChannels[K]>) => ReturnType<IpcChannels[K]>;
} = {
  // File operations
  'file:select-pdb': async () => {
    const file = await selectFile('.pdb');
    if (file) {
      const content = await readFileAsText(file);
      const fakePath = `web://${file.name}`;
      fileStore.set(fakePath, { file, content });
      return fakePath;
    }
    return null;
  },

  'file:select-msa': async () => {
    const file = await selectFile('.a3m');
    if (file) {
      const content = await readFileAsText(file);
      const fakePath = `web://${file.name}`;
      fileStore.set(fakePath, { file, content });
      return fakePath;
    }
    return null;
  },

  'file:select-yaml': async () => {
    const file = await selectFile('.yaml,.yml');
    if (file) {
      const content = await readFileAsText(file);
      const fakePath = `web://${file.name}`;
      fileStore.set(fakePath, { file, content });
      return fakePath;
    }
    return null;
  },

  'file:select-directory': async () => {
    throw new Error(
      'Directory selection is not available in web mode. Type a runner-local directory path instead.'
    );
  },

  'file:read-pdb': async (path: string) => {
    const stored = fileStore.get(path);
    if (stored) {
      return stored.content;
    }
    throw new Error(`File not found: ${path}`);
  },

  'file:normalize-pdb-residues': async (path: string) => {
    const stored = fileStore.get(path);
    if (!stored) {
      throw new Error(`File not found: ${path}`);
    }

    const normalized = normalizePdbResiduesToOneIndexed(stored.content);
    if (!normalized.converted) {
      return {
        path,
        content: stored.content,
        converted: false,
        message: null,
      };
    }

    const normalizedPath = path.replace(/(\.pdb)?$/i, '.1indexed.pdb');
    const normalizedFile = new File([normalized.content], normalizedPath.replace(/^web:\/\//, ''), {
      type: stored.file.type || 'chemical/x-pdb',
    });
    fileStore.set(normalizedPath, { file: normalizedFile, content: normalized.content });

    return {
      path: normalizedPath,
      content: normalized.content,
      converted: true,
      message: normalized.message,
    };
  },

  'file:read-yaml': async (path: string) => {
    const stored = fileStore.get(path);
    if (stored) {
      // Parse YAML - using simple JSON parse for demo (real app would use yaml library)
      try {
        // For web mode, we'll just return a mock config
        console.warn('YAML parsing in web mode returns mock data');
        return getMockConfig();
      } catch {
        throw new Error('Failed to parse YAML');
      }
    }
    throw new Error(`File not found: ${path}`);
  },

  'file:write-yaml': async (_path: string, _config: OptConfig) => {
    // In web mode, download the file instead
    const content = JSON.stringify(_config, null, 2); // Would use YAML.stringify in real app
    const blob = new Blob([content], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.yaml';
    a.click();
    URL.revokeObjectURL(url);
  },

  'file:exists': async (path: string) => {
    return fileStore.has(path);
  },

  // Run management (fallback when runner HTTP service is unavailable)
  'run:start': async (_payload: { config: OptConfig; configPath?: string | null; name?: string | null }) => {
    throw new Error(
      'Local runner is unavailable. Start it with "bun run dev:web" or run "bun run dev:runner" in a separate terminal.'
    );
  },

  'run:stop': async (_runId: string) => {
    throw new Error('Not available in web mode');
  },

  'run:resume': async (_runId: string, _checkpointPath: string, _oracleIdx?: number) => {
    throw new Error('Not available in web mode');
  },

  'run:get-status': async (_runId: string) => {
    return null;
  },

  'run:list': async () => {
    return [];
  },

  'run:delete': async (_runId: string) => {
    throw new Error('Not available in web mode');
  },

  'run:get-checkpoints': async (_runId: string) => {
    return [];
  },

  'run:get-output': async (_runId: string, _tail?: number) => {
    return [];
  },

  'run:import-existing': async (_resultDir: string, _name?: string | null) => {
    throw new Error('Not available in web mode');
  },

  'run:sync-to-cloud': async (_runId: string) => {
    throw new Error('Not available in web mode');
  },

  'run:get-boltz-metrics': async (_runId: string) => {
    return null;
  },

  // Database queries (return mock data for web demo)
  'db:get-generated-objects': async (_dbPath: string, _limit?: number, _offset?: number) => {
    return getMockGeneratedObjects();
  },

  'db:get-boltz-scores': async (_dbPath: string, _limit?: number, _offset?: number) => {
    return getMockBoltzScores();
  },

  'db:get-reward-cache': async (_dbPath: string, _limit?: number) => {
    return getMockRewardCache();
  },

  'db:get-top-molecules': async (_runId: string, _limit?: number) => {
    return getMockMolecules();
  },

  // Boltz complex files
  'boltz:get-complex': async (_runId: string, _oracleIdx: number, _molIdx: number) => {
    return null;
  },
};

// Mock data generators
function getMockConfig(): OptConfig {
  return {
    result_dir: './result/opt/unidock_boltz/demo',
    env_dir: './data/envs/enamine_stock_new',
    max_atoms: 60,
    subsampling_ratio: 0.1,
    protein_path: '',
    center: null,
    ref_ligand_path: null,
    size: [16, 16, 16],
    num_steps: 2000,
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
      target_residues: ['A:16', 'A:67', 'A:138'],
      msa_path: null,
      cache_dir: null,
      use_msa_server: false,
      worker: 1,
    },
  };
}

function getMockGeneratedObjects(): GeneratedObject[] {
  return [
    { smi: 'CC(=O)Oc1ccccc1C(=O)O', r: 0.85, traj: '[]' },
    { smi: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C', r: 0.72, traj: '[]' },
  ];
}

function getMockBoltzScores(): BoltzScore[] {
  return [
    {
      iteration: 100,
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      docking_score: -7.5,
      affinity_ensemble: -8.2,
      probability_ensemble: 0.85,
      affinity_model1: -8.0,
      probability_model1: 0.82,
      affinity_model2: -8.4,
      probability_model2: 0.88,
    },
  ];
}

function getMockRewardCache(): RewardCacheEntry[] {
  return [
    { smiles: 'CC(=O)Oc1ccccc1C(=O)O', reward: 0.85, info: null },
    { smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C', reward: 0.72, info: null },
  ];
}

function getMockMolecules(): MoleculeResult[] {
  return [
    {
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      reward: 0.85,
      trajectory: [
        { step: 0, smiles: '', action: ['block17', '17', '[17*]C[P+](c1ccccc1)(c1ccccc1)c1ccccc1'] },
        { step: 1, smiles: '[17*]C[P+](c1ccccc1)(c1ccccc1)c1ccccc1', action: ['rxn16_brick_b1', '3', '[3*]C1(OC)C[C@@H]2CC[C@H]1C2'] },
      ],
      boltzScores: {
        iteration: 100,
        smiles: 'CC(=O)Oc1ccccc1C(=O)O',
        docking_score: -7.5,
        affinity_ensemble: -8.2,
        probability_ensemble: 0.85,
        affinity_model1: -8.0,
        probability_model1: 0.82,
        affinity_model2: -8.4,
        probability_model2: 0.88,
      },
      complexPath: null,
      oracleIdx: 0,
      molIdx: 0,
    },
    {
      smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
      reward: 0.72,
      trajectory: [
        { step: 0, smiles: '', action: ['block5', '5', '[5*]N1C=NC2=C1C(=O)NC(=O)N2'] },
      ],
      boltzScores: {
        iteration: 50,
        smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
        docking_score: -6.8,
        affinity_ensemble: -7.1,
        probability_ensemble: 0.68,
        affinity_model1: -7.0,
        probability_model1: 0.65,
        affinity_model2: -7.2,
        probability_model2: 0.71,
      },
      complexPath: null,
      oracleIdx: 0,
      molIdx: 1,
    },
  ];
}

// Check if running in Electron
export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}
