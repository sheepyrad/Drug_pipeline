import { useState, useCallback, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { useIpcInvoke, useIpcEvent, useRunOutput } from '@/hooks/useIpc';
import { isWebMode, normalizeRunnerPathInput, validateRunnerReadablePaths } from '@/lib/webMode';
import MolstarViewer from '@/components/MolstarViewer';
import FileSelector from '@/components/FileSelector';
import type { OptConfig, RunInfo, BoltzConfig, FlashBindConfig, OptimizationEngine } from '@shared/types';
import { OptConfigSchema } from '@shared/types';
import { normalizePdbResiduesToOneIndexed } from '@shared/pdbResidues';
import YAML from 'yaml';
import {
  FolderOpen,
  GripVertical,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Square,
  X,
  Microscope,
  Dna,
  SlidersHorizontal,
  Zap,
  FileText,
} from 'lucide-react';

interface ConfigBuilderProps {
  onConfigChange: (config: OptConfig | null) => void;
  onRunStarted: (run: RunInfo) => void;
  activeRun: RunInfo | null;
}

const defaultBoltzConfig: BoltzConfig = {
  base_yaml: '',
  target_residues: [],
  msa_path: null,
  cache_dir: null,
  use_msa_server: false,
  worker: 1,
};

const defaultFlashBindConfig: FlashBindConfig = {
  root: './src/FlashBind',
  protein_id: '',
  pdb_dir: '',
  protein_repr: '',
  ligand_repr: '',
  prots_json: null,
  fabind_checkpoint: '',
  binary_checkpoints: [],
  value_checkpoints: [],
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
  reward_cache_path: null,
  hf_cache: '/media/data/conrad_hku/hf_cache',
};

const defaultConfig: OptConfig = {
  engine: 'boltz',
  result_dir: './result/opt/unidock_boltz/custom',
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
  boltz: defaultBoltzConfig,
  flashbind: defaultFlashBindConfig,
};

const normalizeEngine = (value: unknown): OptimizationEngine =>
  value === 'flashbind' ? 'flashbind' : 'boltz';

const normalizeFlashbindConfig = (value: unknown): FlashBindConfig => {
  const incoming = (value as Partial<FlashBindConfig> | null) ?? {};
  return {
    ...defaultFlashBindConfig,
    ...incoming,
    binary_checkpoints: Array.isArray(incoming.binary_checkpoints)
      ? incoming.binary_checkpoints.filter((v): v is string => typeof v === 'string')
      : defaultFlashBindConfig.binary_checkpoints,
    value_checkpoints: Array.isArray(incoming.value_checkpoints)
      ? incoming.value_checkpoints.filter((v): v is string => typeof v === 'string')
      : defaultFlashBindConfig.value_checkpoints,
  };
};

const getPathFilename = (input: string | null | undefined): string => {
  if (!input) return '';
  const normalized = input.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? '';
};

const getFilenameStem = (filename: string): string => {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return filename;
  return filename.slice(0, idx);
};

const isFlashbindSafeFilename = (filename: string): boolean => /^[A-Za-z0-9.-]+$/.test(filename);

const hasUnsafeRelativePath = (value: string): boolean => value.includes('..');

const normalizeBoltzWorker = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
};

const AMINO_ACID_3_TO_1: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C',
  GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P',
  SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  SEC: 'U', PYL: 'O', MSE: 'M',
};

interface ParsedProteinSequence {
  chainId: string;
  sequence: string;
}

type ResidueLimitsByChain = Record<string, number>;

function oneIndexedPdbFileName(fileName: string): string {
  return fileName.replace(/(\.pdb)?$/i, '.1indexed.pdb');
}

const RESIDUE_SELECTION_PATTERN = /^[A-Za-z0-9]+:[1-9]\d*$/;

function isValidResidueSelection(value: string): boolean {
  return RESIDUE_SELECTION_PATTERN.test(value.trim());
}

function getProteinResidueLimitsFromPdb(pdbContent: string): ResidueLimitsByChain {
  const residuesByChain = new Map<string, Set<number>>();

  for (const line of pdbContent.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue;
    if (line.length < 27) continue;

    const chainId = line.slice(21, 22).trim() || 'A';
    const residueNumber = Number.parseInt(line.slice(22, 26).trim(), 10);
    if (!Number.isFinite(residueNumber) || residueNumber < 1) continue;

    let residues = residuesByChain.get(chainId);
    if (!residues) {
      residues = new Set<number>();
      residuesByChain.set(chainId, residues);
    }
    residues.add(residueNumber);
  }

  const limits: ResidueLimitsByChain = {};
  for (const [chainId, residues] of residuesByChain.entries()) {
    limits[chainId] = Math.max(...residues);
  }
  return limits;
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

function SectionIcon({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
      <Icon className="h-3.5 w-3.5 text-primary" />
    </div>
  );
}

export default function ConfigBuilder({
  onConfigChange,
  onRunStarted,
  activeRun,
}: ConfigBuilderProps) {
  const invoke = useIpcInvoke();
  const runOutput = useRunOutput(activeRun?.id ?? null);
  const [config, setConfig] = useState<OptConfig>(defaultConfig);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [configName, setConfigName] = useState<string>('New Config');
  const [pdbContent, setPdbContent] = useState<string | null>(null);
  const [loadedPdbPath, setLoadedPdbPath] = useState<string | null>(null);
  const [ligandContent, setLigandContent] = useState<string | null>(null);
  const [selectedResidues, setSelectedResidues] = useState<string[]>([]);
  const [newResidue, setNewResidue] = useState('');
  const [residueInputError, setResidueInputError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [pdbResidueMessage, setPdbResidueMessage] = useState<string | null>(null);
  const [pdbLoadError, setPdbLoadError] = useState<string | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(50);
  const [isConfigPanelCollapsed, setIsConfigPanelCollapsed] = useState(false);
  const isFlashBindEngine = config.engine === 'flashbind';
  const webMode = isWebMode();
  const webPathInputProps = webMode
    ? {
        disableLocalPicker: true,
        pathInputMode: true as const,
      }
    : {};

  useEffect(() => {
    onConfigChange(config);
  }, [config, onConfigChange]);

  useIpcEvent(
    'run:status-changed',
    useCallback(
      (runInfo: RunInfo) => {
        if (activeRun && runInfo.id === activeRun.id) {
          onRunStarted(runInfo);
        }
      },
      [activeRun, onRunStarted]
    )
  );

  useIpcEvent(
    'run:error',
    useCallback(
      (runId: string, error: string) => {
        if (!activeRun || runId !== activeRun.id) return;
        onRunStarted({
          ...activeRun,
          status: 'error',
          error,
          lastUpdatedAt: new Date().toISOString(),
        });
      },
      [activeRun, onRunStarted]
    )
  );

  useEffect(() => {
    if (isFlashBindEngine) return;
    setConfig((prev) => ({
      ...prev,
      boltz: {
        ...prev.boltz,
        target_residues: selectedResidues,
      },
    }));
  }, [isFlashBindEngine, selectedResidues]);

  useEffect(() => {
    if (!isFlashBindEngine) return;
    if (selectedResidues.length === 0) return;
    setSelectedResidues([]);
  }, [isFlashBindEngine, selectedResidues.length]);

  useEffect(() => {
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        const proteinPath = normalizeRunnerPathInput(config.protein_path);
        if (!proteinPath) {
          if (!cancelled) {
            setPdbContent(null);
            setLoadedPdbPath(null);
            setPdbResidueMessage(null);
            setPdbLoadError(null);
          }
          return;
        }
        if (proteinPath !== config.protein_path) {
          setConfig((prev) => ({ ...prev, protein_path: proteinPath }));
          return;
        }
        if (loadedPdbPath === proteinPath && pdbContent) return;

        try {
          const normalized = await invoke('file:normalize-pdb-residues', proteinPath);
          if (cancelled) return;
          if (normalized.path !== proteinPath) {
            setConfig((prev) => ({ ...prev, protein_path: normalized.path }));
          }
          setPdbContent(normalized.content);
          setLoadedPdbPath(normalized.path);
          setPdbResidueMessage(normalized.message);
          setPdbLoadError(null);
        } catch (error) {
          if (!cancelled) {
            setPdbContent(null);
            setLoadedPdbPath(null);
            setPdbResidueMessage(null);
            setPdbLoadError(
              error instanceof Error
                ? error.message
                : 'Could not load protein PDB from the given path.'
            );
          }
        }
      })();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config.protein_path, invoke, loadedPdbPath, pdbContent]);

  const generatedBoltzYamlResult = useMemo(() => {
    if (!pdbContent) {
      return { yaml: '', error: null as string | null };
    }
    const sequences = parseProteinSequencesFromPdb(pdbContent);
    if (sequences.length === 0) {
      return { yaml: '', error: 'Could not extract protein sequence from current PDB.' };
    }
    const yaml = YAML.stringify({
      version: 1,
      sequences: sequences.map((entry) => ({
        protein: {
          id: entry.chainId,
          sequence: entry.sequence,
          ...(config.boltz.msa_path ? { msa: config.boltz.msa_path } : {}),
        },
      })),
    });
    return { yaml, error: null as string | null };
  }, [pdbContent, config.boltz.msa_path]);

  const residueLimitsByChain = useMemo(
    () => (pdbContent ? getProteinResidueLimitsFromPdb(pdbContent) : {}),
    [pdbContent]
  );
  const hasLoadedPdbResidues = Object.keys(residueLimitsByChain).length > 0;

  const validateResidueInput = useCallback(
    (value: string): string | null => {
      const residue = value.trim();
      if (!residue) return null;
      if (!hasLoadedPdbResidues) {
        return 'Upload or select a protein PDB before adding target residues.';
      }
      if (!isValidResidueSelection(residue)) {
        return 'Use CHAIN:RESNUM, for example A:123. RESNUM must be a positive integer.';
      }

      const [chainId, residueNumberRaw] = residue.split(':');
      const chainLimit = chainId ? residueLimitsByChain[chainId] : undefined;
      if (chainLimit == null) {
        const chains = Object.keys(residueLimitsByChain).sort().join(', ');
        return `Chain ${chainId ?? ''} is not present in the uploaded PDB${chains ? ` (${chains})` : ''}.`;
      }

      const residueNumber = Number.parseInt(residueNumberRaw ?? '', 10);
      if (residueNumber > chainLimit) {
        return `Residue ${residue} is outside the uploaded PDB range for chain ${chainId} (1-${chainLimit}).`;
      }

      return null;
    },
    [hasLoadedPdbResidues, residueLimitsByChain]
  );

  useEffect(() => {
    setSelectedResidues((prev) => prev.filter((residue) => validateResidueInput(residue) === null));
  }, [validateResidueInput]);

  const molecularBudget = config.num_steps * config.num_sampling_per_step;
  const formattedMolecularBudget = new Intl.NumberFormat().format(molecularBudget);

  const handleSelectPdb = useCallback(async (): Promise<string | null> => {
    setIsLoading(true);
    try {
      const path = await invoke('file:select-pdb');
      if (path) {
        const normalized = await invoke('file:normalize-pdb-residues', path);
        setPdbContent(normalized.content);
        setLoadedPdbPath(normalized.path);
        setPdbResidueMessage(normalized.message);
        return normalized.path;
      }
      return path;
    } finally {
      setIsLoading(false);
    }
  }, [invoke]);

  const preparePdbFileForUpload = useCallback(async (file: File) => {
    const content = await file.text();
    const normalized = normalizePdbResiduesToOneIndexed(content);
    setPdbResidueMessage(normalized.message);

    if (!normalized.converted) {
      return { file, content };
    }

    return {
      file: new File([normalized.content], oneIndexedPdbFileName(file.name), {
        type: file.type || 'chemical/x-pdb',
      }),
      content: normalized.content,
    };
  }, []);

  const handleSelectMsa = useCallback(async (): Promise<string | null> => {
    return await invoke('file:select-msa');
  }, [invoke]);

  const handleSelectLigand = useCallback(async (): Promise<string | null> => {
    return invoke('file:select-ligand');
  }, [invoke]);

  const handleSelectProtsJson = useCallback(async (): Promise<string | null> => {
    return invoke('file:select-json');
  }, [invoke]);

  const handleSelectResultDir = useCallback(async () => {
    const path = await invoke('file:select-directory');
    if (path) {
      setConfig((prev) => ({ ...prev, result_dir: path }));
    }
  }, [invoke]);

  const handleSelectEnvDir = useCallback(async () => {
    const path = await invoke('file:select-directory');
    if (path) {
      setConfig((prev) => ({ ...prev, env_dir: path }));
    }
  }, [invoke]);

  const handleResidueSelect = useCallback((residues: string[]) => {
    setSelectedResidues(residues.filter((residue) => validateResidueInput(residue) === null));
  }, [validateResidueInput]);

  const handleAddResidue = useCallback(() => {
    const residue = newResidue.trim();
    const validationError =
      validateResidueInput(residue) ??
      (!residue && !hasLoadedPdbResidues ? 'Upload or select a protein PDB before adding target residues.' : null);
    if (validationError) {
      setResidueInputError(validationError);
      return;
    }
    if (!residue) return;

    setResidueInputError(null);
    if (!selectedResidues.includes(residue)) {
      setSelectedResidues((prev) => [...prev, residue]);
    }
    setNewResidue('');
  }, [hasLoadedPdbResidues, newResidue, selectedResidues, validateResidueInput]);

  const handleRemoveResidue = useCallback((residue: string) => {
    setSelectedResidues((prev) => prev.filter((r) => r !== residue));
  }, []);

  const handleSaveConfig = useCallback(async () => {
    const path = await invoke('file:select-yaml');
    if (path) {
      await invoke('file:write-yaml', path, config);
      setConfigPath(path);
    }
  }, [invoke, config]);

  const handleStartRun = useCallback(async () => {
    if (isFlashBindEngine) {
      const proteinId = config.flashbind?.protein_id?.trim() ?? '';
      if (!proteinId) {
        setStartError('FlashBind requires `protein_id`.');
        return;
      }
      const protsJsonPath = config.flashbind?.prots_json;
      if (!protsJsonPath) {
        setStartError('FlashBind requires `prots_json`.');
        return;
      }

      const proteinFilename = getPathFilename(config.protein_path);
      const protsJsonFilename = getPathFilename(protsJsonPath);
      for (const item of [
        { label: 'protein file', value: proteinFilename },
        { label: 'prots_json file', value: protsJsonFilename },
      ]) {
        if (!item.value) {
          setStartError(`FlashBind requires a valid ${item.label} name.`);
          return;
        }
        if (!isFlashbindSafeFilename(item.value) || item.value.includes('_')) {
          setStartError(
            `FlashBind ${item.label} "${item.value}" is invalid. Use only letters/numbers/dot/hyphen; no spaces, symbols, or underscores (_).`
          );
          return;
        }
      }

      const proteinStem = getFilenameStem(proteinFilename);
      if (proteinStem !== proteinId) {
        setStartError(
          `FlashBind requires protein_id (${proteinId}) to match protein filename stem (${proteinStem}).`
        );
        return;
      }
    }

    if (hasUnsafeRelativePath(config.result_dir) || hasUnsafeRelativePath(config.env_dir)) {
      setStartError('Directory paths cannot contain ".." path traversal sequences.');
      return;
    }

    const runnerPathError = validateRunnerReadablePaths(config);
    if (runnerPathError) {
      setStartError(runnerPathError);
      return;
    }

    const parsedConfig = OptConfigSchema.safeParse(config);
    if (!parsedConfig.success) {
      setValidationErrors(
        parsedConfig.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      );
      setStartError('Configuration validation failed. Fix the errors below.');
      return;
    }

    setIsLoading(true);
    setStartError(null);
    setValidationErrors([]);
    try {
      const runInfo = await invoke('run:start', {
        config: parsedConfig.data,
        configPath,
        name: configName.trim() || undefined,
      });
      onRunStarted(runInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start run.';
      setStartError(message);
    } finally {
      setIsLoading(false);
    }
  }, [invoke, config, configPath, onRunStarted, configName, isFlashBindEngine]);

  const handleStopRun = useCallback(async () => {
    if (activeRun) {
      await invoke('run:stop', activeRun.id);
    }
  }, [invoke, activeRun]);

  const isRunning = activeRun?.status === 'running';
  const runStatusVariant =
    activeRun?.status === 'running'
      ? 'success'
      : activeRun?.status === 'error'
        ? 'destructive'
        : activeRun?.status === 'paused'
          ? 'warning'
          : 'secondary';

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel - Config form */}
      <div
        className="relative shrink-0 border-r border-border bg-background transition-[width] duration-200"
        style={{ width: isConfigPanelCollapsed ? 64 : `${leftPanelWidth}%` }}
      >
        {isConfigPanelCollapsed ? (
          <div className="flex h-full flex-col items-center gap-3 border-r border-border bg-card/70 p-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Expand configuration panel"
              onClick={() => setIsConfigPanelCollapsed(false)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10" title="Run configuration">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
            </div>
            {activeRun ? (
              <div className="mt-auto mb-1 h-8 w-8 rounded-md border border-primary/20 bg-primary/10 p-1.5" title={`${activeRun.name}: ${activeRun.status}`}>
                <Zap className="h-4 w-4 text-primary" />
              </div>
            ) : null}
          </div>
        ) : (
        <>
        <ScrollArea className="h-full">
          <div className="flex min-h-full flex-col gap-3 p-3">
            {/* Page header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-semibold tracking-tight">
                  Run Configuration
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Prepare and launch molecular optimization jobs with {isFlashBindEngine ? 'FlashBind' : 'Boltz-2'}.
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                title="Collapse configuration panel"
                onClick={() => setIsConfigPanelCollapsed(true)}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>

            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <CardTitle className="font-display text-sm">Optimization Engine</CardTitle>
                <CardDescription className="text-xs">Choose the scoring backend for this run.</CardDescription>
              </CardHeader>
              <CardContent className="p-3 pt-0">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={config.engine === 'boltz' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        engine: 'boltz',
                        boltz: {
                          ...prev.boltz,
                          target_residues:
                            selectedResidues.length > 0 ? selectedResidues : prev.boltz.target_residues,
                        },
                      }))
                    }
                  >
                    Boltz
                  </Button>
                  <Button
                    variant={config.engine === 'flashbind' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        engine: 'flashbind',
                        flashbind: prev.flashbind ?? defaultFlashBindConfig,
                        boltz: { ...prev.boltz, target_residues: [] },
                      }))
                    }
                  >
                    FlashBind
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-1 flex-col gap-3">

            {/* Config management */}
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={FileText} />
                  <div>
                    <CardTitle className="font-display text-sm">Configuration</CardTitle>
                    <CardDescription className="text-xs">Name this setup for dashboard tracking.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                <div className="space-y-1">
                  <Label htmlFor="config-name" className="text-xs font-medium text-muted-foreground">Config name</Label>
                  <Input
                    id="config-name"
                    value={configName}
                    onChange={(e) => setConfigName(e.target.value)}
                    placeholder="Name this configuration"
                    className="h-8"
                  />
                </div>

                <Button variant="outline" size="sm" onClick={handleSaveConfig} className="w-full">
                  <Save className="mr-2 h-3.5 w-3.5" />
                  Save Config
                </Button>

                {configPath ? (
                  <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 font-data text-[11px] text-muted-foreground">
                    {configPath}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Input files */}
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={Microscope} />
                  <div>
                    <CardTitle className="font-display text-sm">Input Files</CardTitle>
                    <CardDescription className="text-xs">
                      Protein and reference ligand inputs for {isFlashBindEngine ? 'FlashBind' : 'Boltz'}.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                {webMode ? (
                  <div className="rounded-md border border-border/60 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                    Web mode uses runner-local paths. Type absolute or workspace-relative paths for
                    inputs and directories, or use Convex uploads where available.
                  </div>
                ) : null}
                <FileSelector
                  label="Protein PDB"
                  value={config.protein_path}
                  onChange={(path) => setConfig((prev) => ({ ...prev, protein_path: path }))}
                  onContentLoaded={(content) => setPdbContent(content)}
                  fieldType="protein_pdb"
                  fileType="pdb"
                  accept=".pdb"
                  placeholder="Select protein .pdb file"
                  pathInputPlaceholder="/path/to/protein.pdb"
                  onSelectLocal={handleSelectPdb}
                  onReadLocalContent={async (path) => await invoke('file:read-pdb', path)}
                  prepareFileForUpload={preparePdbFileForUpload}
                  {...webPathInputProps}
                />

                {pdbResidueMessage ? (
                  <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    {pdbResidueMessage}
                  </div>
                ) : null}

                {pdbLoadError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {pdbLoadError}
                    {webMode ? ' Restart the runner if you recently updated the app.' : null}
                  </div>
                ) : null}

                <FileSelector
                  label="Reference ligand"
                  value={config.ref_ligand_path ?? ''}
                  onChange={(path) =>
                    setConfig((prev) => ({
                      ...prev,
                      ref_ligand_path: path || null,
                    }))
                  }
                  onContentLoaded={(content) => setLigandContent(content)}
                  fieldType="other"
                  fileType="other"
                  accept=".mol2,.sdf,.mol,.pdb,.cif,.mmcif"
                  placeholder="Select reference ligand file"
                  pathInputPlaceholder="/path/to/reference_ligand.sdf"
                  optional
                  onSelectLocal={handleSelectLigand}
                  onReadLocalContent={async (path) => await invoke('file:read-text', path)}
                  {...webPathInputProps}
                />

                {isFlashBindEngine ? (
                  <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-200">
                      FlashBind Naming Constraint
                    </p>
                    <p className="text-xs text-amber-100/90">
                      Protein and prots_json filenames must not contain spaces, special symbols, or underscores (_).
                      Also ensure `protein_id` exactly matches the protein filename stem.
                    </p>
                  </div>
                ) : null}

                {isFlashBindEngine ? (
                  <div className="space-y-1">
                    <Label htmlFor="flashbind-protein-id" className="text-xs font-medium text-muted-foreground">
                      FlashBind protein_id
                    </Label>
                    <Input
                      id="flashbind-protein-id"
                      value={config.flashbind?.protein_id ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          flashbind: {
                            ...(prev.flashbind ?? defaultFlashBindConfig),
                            protein_id: e.target.value.trim(),
                          },
                        }))
                      }
                      placeholder="Must match protein filename stem (e.g. NS5)"
                      className="h-8 font-data"
                    />
                  </div>
                ) : null}

                {isFlashBindEngine ? (
                  <FileSelector
                    label="FlashBind prots_json"
                    value={config.flashbind?.prots_json ?? ''}
                    onChange={(path) =>
                      setConfig((prev) => ({
                        ...prev,
                        flashbind: {
                          ...(prev.flashbind ?? defaultFlashBindConfig),
                          prots_json: path || null,
                        },
                      }))
                    }
                    fieldType="other"
                    fileType="other"
                    accept=".json"
                    placeholder="Select FlashBind prots.json"
                    pathInputPlaceholder="/path/to/prots.json"
                    onSelectLocal={handleSelectProtsJson}
                    onReadLocalContent={async (path) => await invoke('file:read-text', path)}
                    {...webPathInputProps}
                  />
                ) : null}

                {!isFlashBindEngine ? (
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground">Boltz YAML preview</Label>
                  <div className="rounded-md border border-border bg-secondary/20 p-2">
                    {generatedBoltzYamlResult.error ? (
                      <p className="text-xs text-destructive">{generatedBoltzYamlResult.error}</p>
                    ) : generatedBoltzYamlResult.yaml ? (
                      <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-all font-data text-[10px] leading-4 text-foreground/80">
                        {generatedBoltzYamlResult.yaml}
                      </pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Choose a protein PDB to preview.
                      </p>
                    )}
                  </div>
                </div>
                ) : null}

                {!isFlashBindEngine ? (
                <div className="rounded-md border border-accent/30 bg-accent/10 p-2">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Label className="text-xs font-medium text-foreground">MSA file</Label>
                    <Badge variant="warning" className="font-data text-[10px]">Optional</Badge>
                  </div>
                  <FileSelector
                    label="Alignment input"
                    value={config.boltz.msa_path ?? ''}
                    onChange={(path) =>
                      setConfig((prev) => ({
                        ...prev,
                        boltz: { ...prev.boltz, msa_path: path || null },
                      }))
                    }
                    fieldType="msa"
                    fileType="msa"
                    accept=".a3m"
                    placeholder="Select optional MSA file"
                    pathInputPlaceholder="/path/to/alignment.a3m"
                    optional
                    onSelectLocal={handleSelectMsa}
                    {...webPathInputProps}
                  />
                </div>
                ) : null}

                {!isFlashBindEngine ? (
                <div className="space-y-1">
                  <Label htmlFor="boltz-workers" className="text-xs font-medium text-muted-foreground">Boltz workers</Label>
                  <Input
                    id="boltz-workers"
                    type="number"
                    min={1}
                    value={config.boltz.worker}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        boltz: {
                          ...prev.boltz,
                          worker: normalizeBoltzWorker(e.target.value),
                        },
                      }))
                    }
                    className="h-8 font-data tabular-nums"
                  />
                </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Target residues */}
            {!isFlashBindEngine ? (
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={Dna} />
                  <div>
                    <CardTitle className="font-display text-sm">Target Residues</CardTitle>
                    <CardDescription className="text-xs">Pick in viewer or enter CHAIN:RESID.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Selected</span>
                  <Badge variant="outline" className="font-data text-[10px]">{selectedResidues.length}</Badge>
                </div>

                {selectedResidues.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedResidues.map((residue) => (
                      <Badge key={residue} variant="secondary" className="gap-1 pr-1 font-data text-[11px]">
                        {residue}
                        <button
                          onClick={() => handleRemoveResidue(residue)}
                          className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border bg-secondary/20 px-3 py-2 text-center text-xs text-muted-foreground">
                    No residues selected yet.
                  </div>
                )}

                <div className="flex gap-2">
                  <Input
                    value={newResidue}
                    onChange={(e) => {
                      setNewResidue(e.target.value);
                      if (residueInputError && (!e.target.value.trim() || validateResidueInput(e.target.value) === null)) {
                        setResidueInputError(null);
                      }
                    }}
                    placeholder={hasLoadedPdbResidues ? 'A:123' : 'Upload PDB first'}
                    disabled={!hasLoadedPdbResidues}
                    aria-invalid={Boolean(residueInputError)}
                    className={`h-8 font-data ${residueInputError ? 'border-destructive focus-visible:ring-destructive/40' : ''}`}
                    onKeyDown={(e) => e.key === 'Enter' && hasLoadedPdbResidues && handleAddResidue()}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={handleAddResidue}
                    disabled={!hasLoadedPdbResidues}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  {selectedResidues.length > 0 ? (
                    <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelectedResidues([])}>
                      Clear
                    </Button>
                  ) : null}
                </div>
                {residueInputError ? (
                  <p className="text-xs text-destructive">{residueInputError}</p>
                ) : !hasLoadedPdbResidues ? (
                  <p className="text-xs text-muted-foreground">Upload or select a protein PDB before adding target residues.</p>
                ) : null}
              </CardContent>
            </Card>
            ) : null}

            {/* Optimization parameters */}
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={SlidersHorizontal} />
                  <div>
                    <CardTitle className="font-display text-sm">Optimization Parameters</CardTitle>
                    <CardDescription className="text-xs">Core sampling controls.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="field-grid p-3 pt-0">
                <div className="space-y-1">
                  <Label htmlFor="num-steps" className="text-xs font-medium text-muted-foreground">Iterations</Label>
                  <Input
                    id="num-steps"
                    type="number"
                    value={config.num_steps}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, num_steps: parseInt(e.target.value) || 0 }))
                    }
                    className="h-8 font-data tabular-nums"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="samples-per-step" className="text-xs font-medium text-muted-foreground">Samples per iteration</Label>
                  <Input
                    id="samples-per-step"
                    type="number"
                    value={config.num_sampling_per_step}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        num_sampling_per_step: parseInt(e.target.value) || 0,
                      }))
                    }
                    className="h-8 font-data tabular-nums"
                  />
                </div>

                <div className="rounded-md border border-primary/20 bg-primary/[0.04] p-2 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Molecular budget</p>
                      <p className="font-data text-[10px] text-muted-foreground tabular-nums">
                        {config.num_steps.toLocaleString()} iterations x {config.num_sampling_per_step.toLocaleString()} samples
                      </p>
                    </div>
                    <div className="font-data text-base font-semibold tabular-nums text-primary">
                      {formattedMolecularBudget}
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-atoms" className="text-xs font-medium text-muted-foreground">Max atoms</Label>
                  <Input
                    id="max-atoms"
                    type="number"
                    value={config.max_atoms}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, max_atoms: parseInt(e.target.value) || 0 }))
                    }
                    className="h-8 font-data tabular-nums"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="seed" className="text-xs font-medium text-muted-foreground">Seed</Label>
                  <Input
                    id="seed"
                    type="number"
                    value={config.seed}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, seed: parseInt(e.target.value) || 0 }))
                    }
                    className="h-8 font-data tabular-nums"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Directories */}
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={FolderOpen} />
                  <div>
                    <CardTitle className="font-display text-sm">Directories</CardTitle>
                    <CardDescription className="text-xs">Output and environment locations.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                <div className="space-y-1">
                  <Label htmlFor="result-dir" className="text-xs font-medium text-muted-foreground">Result directory</Label>
                  <div className="flex gap-2">
                    <Input
                      id="result-dir"
                      value={config.result_dir}
                      onChange={(e) => setConfig((prev) => ({ ...prev, result_dir: e.target.value }))}
                      className="h-8 font-data text-xs"
                      placeholder={webMode ? '/path/to/result_dir' : undefined}
                    />
                    {!webMode ? (
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleSelectResultDir}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  {webMode ? (
                    <p className="text-[11px] text-muted-foreground">
                      Type a directory path accessible to the local runner.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="env-dir" className="text-xs font-medium text-muted-foreground">Environment directory</Label>
                  <div className="flex gap-2">
                    <Input
                      id="env-dir"
                      value={config.env_dir}
                      onChange={(e) => setConfig((prev) => ({ ...prev, env_dir: e.target.value }))}
                      className="h-8 font-data text-xs"
                      placeholder={webMode ? '/path/to/env_dir' : undefined}
                    />
                    {!webMode ? (
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleSelectEnvDir}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  {webMode ? (
                    <p className="text-[11px] text-muted-foreground">
                      Type a directory path accessible to the local runner.
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            {/* Run controls */}
            <Card className="h-fit rounded-md border-border/40 bg-transparent shadow-none">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center gap-2">
                  <SectionIcon icon={Zap} />
                  <div>
                    <CardTitle className="font-display text-sm">Run Controls</CardTitle>
                    <CardDescription className="text-xs">Launch or stop optimization.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-3 pt-0">
                <div className="flex gap-2">
                  <Button
                    onClick={handleStartRun}
                    disabled={isRunning || isLoading || !config.protein_path}
                    size="sm"
                    className="flex-1 glow-primary"
                  >
                    {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    Start Training
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleStopRun} disabled={!isRunning}>
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                </div>

                {activeRun ? (
                  <div className="space-y-2 rounded-md border border-primary/15 bg-primary/[0.03] p-2 animate-fade-in">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{activeRun.name}</p>
                        <p className="font-data text-[11px] text-muted-foreground tabular-nums">
                          {activeRun.currentStep} of {activeRun.totalSteps} iterations
                        </p>
                      </div>
                      <Badge variant={runStatusVariant}>{activeRun.status}</Badge>
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between font-data text-[10px] text-muted-foreground">
                        <span>Progress</span>
                        <span className="tabular-nums">
                          {activeRun.currentStep} / {activeRun.totalSteps}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-500"
                          style={{
                            width: `${Math.min(
                              100,
                              activeRun.totalSteps > 0
                                ? (activeRun.currentStep / activeRun.totalSteps) * 100
                                : 0
                            )}%`,
                          }}
                        />
                      </div>
                    </div>

                    {(activeRun.error || startError) ? (
                      <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {activeRun.error ?? startError}
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                        Recent Logs
                      </p>
                      <div className="max-h-24 overflow-auto rounded-md border border-border bg-background p-2">
                        <pre className="whitespace-pre-wrap break-words font-data text-[10px] leading-relaxed text-muted-foreground">
                          {runOutput.length > 0 ? runOutput.slice(-24).join('\n') : 'No output yet.'}
                        </pre>
                      </div>
                    </div>
                  </div>
                ) : startError ? (
                  <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {startError}
                  </div>
                ) : null}
                {validationErrors.length > 0 ? (
                  <ul className="space-y-1 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {validationErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
            </div>
          </div>
        </ScrollArea>

        {/* Resize handle */}
        <div
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-primary/20"
          onMouseDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startPercent = leftPanelWidth;
            const container = (event.currentTarget as HTMLDivElement).parentElement?.parentElement;
            const containerWidth = container?.clientWidth ?? 1;
            const onMove = (moveEvent: MouseEvent) => {
              const deltaPercent = ((moveEvent.clientX - startX) / containerWidth) * 100;
              const nextPercent = startPercent + deltaPercent;
              setLeftPanelWidth(Math.max(30, Math.min(70, nextPercent)));
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
          title="Drag to resize panel"
        >
          <div className="flex h-full items-center justify-center">
            <GripVertical className="h-4 w-4 text-muted-foreground/30" />
          </div>
        </div>
        </>
        )}
      </div>

      {/* Right panel - 3D Viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border bg-card/50 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Protein Structure</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isFlashBindEngine
                  ? 'Preview uploaded protein and reference ligand for FlashBind.'
                  : 'Click residues in the viewer to update the target list.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!isFlashBindEngine ? (
                <Badge variant="outline" className="font-data text-[10px]">{selectedResidues.length} residues</Badge>
              ) : null}
              {config.protein_path ? (
                <Badge variant="secondary" className="max-w-[280px] truncate font-data text-[10px]">
                  {config.protein_path.split('/').pop()}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex-1 bg-background">
          <MolstarViewer
            pdbContent={pdbContent}
            ligandContent={ligandContent}
            selectedResidues={isFlashBindEngine ? [] : selectedResidues}
            onResidueSelect={isFlashBindEngine ? () => {} : handleResidueSelect}
            multiSelectMode={!isFlashBindEngine}
          />
        </div>
      </div>
    </div>
  );
}
