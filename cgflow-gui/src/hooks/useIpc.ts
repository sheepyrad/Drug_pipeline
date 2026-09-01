import { useCallback, useEffect, useState } from 'react';
import type { IpcChannels, IpcEvents, RunInfo } from '@shared/types';
import { webFallback, isElectron } from '@/lib/webFallback';
import { normalizeRunnerPathInput } from '@/lib/webMode';
import { runnerClient } from '@/lib/runnerClient';

function isBrowserOnlyPath(value: string): boolean {
  return value.startsWith('web://') || value.startsWith('convex://');
}

async function invokeFileChannel<K extends keyof IpcChannels>(
  channel: K,
  ...args: Parameters<IpcChannels[K]>
): Promise<Awaited<ReturnType<IpcChannels[K]>>> {
  const rawPath = typeof args[0] === 'string' ? args[0] : null;
  const filePath = rawPath ? normalizeRunnerPathInput(rawPath) : null;

  if (filePath && !isBrowserOnlyPath(filePath)) {
    const available = await runnerClient.isAvailable();
    if (available) {
      switch (channel) {
        case 'file:read-pdb':
        case 'file:read-text':
          return (await runnerClient.readTextFile(filePath)) as Awaited<ReturnType<IpcChannels[K]>>;
        case 'file:normalize-pdb-residues':
          return (await runnerClient.normalizePdbResidues(filePath)) as Awaited<
            ReturnType<IpcChannels[K]>
          >;
        default:
          break;
      }
    }
  }

  if (isElectron()) {
    const trimmedArgs =
      filePath && typeof args[0] === 'string'
        ? ([filePath, ...args.slice(1)] as Parameters<IpcChannels[K]>)
        : args;
    return await window.electronAPI.invoke(channel, ...trimmedArgs);
  }
  const trimmedArgs =
    filePath && typeof args[0] === 'string'
      ? ([filePath, ...args.slice(1)] as Parameters<IpcChannels[K]>)
      : args;
  return await webFallback[channel](...trimmedArgs);
}

// Typed IPC invoke hook - uses Electron API if available, falls back to web implementation
export function useIpcInvoke() {
  return useCallback(
    async <K extends keyof IpcChannels>(
      channel: K,
      ...args: Parameters<IpcChannels[K]>
    ): Promise<Awaited<ReturnType<IpcChannels[K]>>> => {
      const runnerChannels: Array<keyof IpcChannels> = [
        'run:start',
        'run:stop',
        'run:resume',
        'run:get-status',
        'run:list',
        'run:get-checkpoints',
        'run:get-output',
        'run:delete',
        'run:import-existing',
        'run:sync-to-cloud',
        'run:get-boltz-metrics',
        'db:get-top-molecules',
        'boltz:get-complex',
      ];

      if (runnerChannels.includes(channel)) {
        const available = await runnerClient.isAvailable();
        if (available) {
          switch (channel) {
            case 'run:start':
              return runnerClient.startRun(
                args[0] as Parameters<IpcChannels['run:start']>[0]
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:stop':
              return runnerClient.stopRun(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:resume':
              return runnerClient.resumeRun(
                args[0] as string,
                args[1] as string,
                args[2] as number | undefined
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:get-status':
              return runnerClient.getRun(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:list':
              return runnerClient.listRuns() as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:delete':
              return runnerClient.deleteRun(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:get-checkpoints':
              return runnerClient.getCheckpoints(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:get-output':
              return runnerClient.getOutput(
                args[0] as string,
                (args[1] as number | undefined) ?? 500
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:import-existing':
              return runnerClient.importExistingRun(
                args[0] as string,
                (args[1] as string | null | undefined) ?? null
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:sync-to-cloud':
              return runnerClient.syncRunToCloud(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'run:get-boltz-metrics':
              return runnerClient.getBoltzMetrics(args[0] as string) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'db:get-top-molecules':
              return runnerClient.getTopMolecules(
                args[0] as string,
                args[1] as number | undefined
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            case 'boltz:get-complex':
              return runnerClient.getComplex(
                args[0] as string,
                args[1] as number,
                args[2] as number
              ) as Awaited<ReturnType<IpcChannels[K]>>;
            default:
              break;
          }
        }
      }

      if (
        channel === 'run:delete' ||
        channel === 'run:import-existing' ||
        channel === 'run:sync-to-cloud' ||
        channel === 'run:get-boltz-metrics'
      ) {
        throw new Error('Runner server is not available for this operation.');
      }

      if (
        channel === 'file:read-pdb' ||
        channel === 'file:read-text' ||
        channel === 'file:normalize-pdb-residues'
      ) {
        return await invokeFileChannel(channel, ...args);
      }

      if (isElectron()) {
        return await window.electronAPI.invoke(channel, ...args);
      }
      // Use web fallback
      return await webFallback[channel](...args);
    },
    []
  );
}

// Hook for IPC events
export function useIpcEvent<K extends keyof IpcEvents>(
  channel: K,
  handler: IpcEvents[K]
) {
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const setup = async () => {
      const runnerEvents: Array<keyof IpcEvents> = [
        'run:output',
        'run:status-changed',
        'run:checkpoint-saved',
        'run:error',
      ];

      if (runnerEvents.includes(channel)) {
        const available = await runnerClient.isAvailable();
        if (available) {
          unsubscribe = runnerClient.on(channel as any, handler as any);
          return;
        }
      }

      if (isElectron()) {
        unsubscribe = window.electronAPI.on(channel, handler);
      }
    };

    void setup();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel, handler]);
}

// Hook for run status changes
export function useRunStatus(runId: string | null) {
  const [status, setStatus] = useState<RunInfo | null>(null);
  const invoke = useIpcInvoke();

  useEffect(() => {
    if (!runId) {
      setStatus(null);
      return;
    }

    // Initial fetch
    invoke('run:get-status', runId).then((value) => setStatus(value));

    let unsubscribe: (() => void) | undefined;
    const setup = async () => {
      const available = await runnerClient.isAvailable();
      if (available) {
        unsubscribe = runnerClient.on('run:status-changed', (info: RunInfo) => {
          if (info.id === runId) {
            setStatus(info);
          }
        });
        return;
      }
      if (isElectron()) {
        unsubscribe = window.electronAPI.on('run:status-changed', (info: RunInfo) => {
          if (info.id === runId) {
            setStatus(info);
          }
        });
      }
    };

    void setup();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [runId, invoke]);

  return status;
}

// Hook for run output
export function useRunOutput(runId: string | null) {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    if (!runId) {
      setOutput([]);
      return;
    }

    let unsubscribe: (() => void) | undefined;
    const setup = async () => {
      const available = await runnerClient.isAvailable();
      if (available) {
        unsubscribe = runnerClient.on('run:output', ({ runId: id, output: line }) => {
          if (id === runId) {
            setOutput((prev) => [...prev.slice(-500), line]);
          }
        });
        return;
      }

      if (isElectron()) {
        unsubscribe = window.electronAPI.on('run:output', (id: string, line: string) => {
          if (id === runId) {
            setOutput((prev) => [...prev.slice(-500), line]);
          }
        });
      }
    };

    void setup();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [runId]);

  return output;
}
