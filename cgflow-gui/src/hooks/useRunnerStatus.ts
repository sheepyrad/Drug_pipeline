import { useCallback, useEffect, useState } from 'react';
import { getRunnerUrl, runnerClient, type RunnerHealth } from '@/lib/runnerClient';

export type RunnerStatusState = 'checking' | 'ready' | 'unavailable' | 'error';

export function useRunnerStatus(pollIntervalMs = 10_000) {
  const [status, setStatus] = useState<RunnerStatusState>('checking');
  const [health, setHealth] = useState<RunnerHealth | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const runnerUrl = getRunnerUrl();

  const refresh = useCallback(async () => {
    setStatus('checking');
    try {
      const result = await runnerClient.checkHealth(true);
      setHealth(result);
      if (result.ok) {
        setStatus('ready');
        setLastError(null);
        return;
      }
      setStatus(result.reachable ? 'error' : 'unavailable');
      setLastError(result.error ?? 'Runner health check failed.');
    } catch (error) {
      setHealth(null);
      setStatus('unavailable');
      setLastError(error instanceof Error ? error.message : 'Runner health check failed.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh]);

  return {
    status,
    health,
    lastError,
    runnerUrl,
    refresh,
  };
}
