import { Button } from '@/components/ui/button';
import { useRunnerStatus, type RunnerStatusState } from '@/hooks/useRunnerStatus';
import { isWebMode } from '@/lib/webMode';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, ServerCrash, WifiOff } from 'lucide-react';

const STATUS_META: Record<
  RunnerStatusState,
  {
    label: string;
    icon: typeof CheckCircle2;
    className: string;
  }
> = {
  checking: {
    label: 'Checking runner',
    icon: Loader2,
    className: 'border-border/60 bg-secondary/40 text-muted-foreground',
  },
  ready: {
    label: 'Runner ready',
    icon: CheckCircle2,
    className: 'border-success/30 bg-success/10 text-success',
  },
  unavailable: {
    label: 'Runner unavailable',
    icon: WifiOff,
    className: 'border-warning/30 bg-warning/10 text-warning',
  },
  error: {
    label: 'Runner error',
    icon: ServerCrash,
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
};

function getStatusMessage(params: {
  status: RunnerStatusState;
  runnerUrl: string;
  lastError: string | null;
  runCount?: number;
}): string {
  const { status, runnerUrl, lastError, runCount } = params;

  if (status === 'ready') {
    const runSuffix = typeof runCount === 'number' ? ` · ${runCount} tracked run(s)` : '';
    return `Connected to ${runnerUrl}${runSuffix}`;
  }

  if (status === 'checking') {
    return `Checking ${runnerUrl}...`;
  }

  if (status === 'error') {
    return lastError ?? `Runner at ${runnerUrl} returned an unhealthy response.`;
  }

  if (isWebMode()) {
    return `Cannot reach ${runnerUrl}. Start the runner with "bun run dev:web" or "bun run dev:runner".`;
  }

  return `Cannot reach ${runnerUrl}. Ensure the local runner service is running.`;
}

export default function RunnerStatusBar() {
  const { status, health, lastError, runnerUrl, refresh } = useRunnerStatus();
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const message = getStatusMessage({
    status,
    runnerUrl,
    lastError,
    runCount: health?.runs,
  });

  return (
    <div className={`flex items-center gap-3 border-b px-4 py-2 text-xs ${meta.className}`}>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${status === 'checking' ? 'animate-spin' : ''}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{meta.label}</span>
          {status === 'error' || status === 'unavailable' ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 opacity-80" />
          ) : null}
        </div>
        <p className="truncate text-[11px] opacity-90">{message}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => void refresh()}
        title="Refresh runner status"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
