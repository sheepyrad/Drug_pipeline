import { useEffect, useState } from 'react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ConfigBuilder from '@/pages/ConfigBuilder';
import Dashboard from '@/pages/Dashboard';
import RunnerStatusBar from '@/components/RunnerStatusBar';
import type { RunInfo, OptConfig } from '@shared/types';
import {
  Activity,
  FlaskConical,
  Hexagon,
  LayoutDashboard,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
} from 'lucide-react';

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  collapsed,
}: {
  icon: React.ElementType;
  label: string;
  active: boolean;
  onClick: () => void;
  collapsed: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`group flex w-full items-center rounded-md text-sm font-medium transition-all duration-200
        ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'}
        ${active
          ? 'bg-primary/10 text-primary shadow-sm'
          : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground'
        }`}
    >
      <Icon className={`h-[18px] w-[18px] transition-colors ${active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} />
      {!collapsed ? <span>{label}</span> : null}
      {active && !collapsed ? (
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary animate-pulse-glow" />
      ) : null}
    </button>
  );
}

type ThemePreference = 'dark' | 'light';

export default function App() {
  const [activeRun, setActiveRun] = useState<RunInfo | null>(null);
  const [, setCurrentConfig] = useState<OptConfig | null>(null);
  const [activeTab, setActiveTab] = useState('config');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'dark';
    const storedTheme = window.localStorage.getItem('cgflow.theme');
    if (storedTheme === 'dark' || storedTheme === 'light') return storedTheme;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.theme = theme;
    window.localStorage.setItem('cgflow.theme', theme);
  }, [theme]);

  const runStatusVariant =
    activeRun?.status === 'running'
      ? 'success'
      : activeRun?.status === 'error'
        ? 'destructive'
        : activeRun?.status === 'paused'
          ? 'warning'
          : 'secondary';

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full">
        {/* Sidebar */}
        <aside
          className={`flex shrink-0 flex-col border-r border-border bg-card/95 shadow-sm transition-[width] duration-200 ${
            isSidebarCollapsed ? 'w-[72px]' : 'w-[244px]'
          }`}
        >
          {/* Logo */}
          <div className={`flex items-center gap-3 px-4 py-4 ${isSidebarCollapsed ? 'justify-center' : ''}`}>
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 glow-subtle">
              <Hexagon className="h-4 w-4 text-primary" />
            </div>
            {!isSidebarCollapsed ? (
            <div>
              <h1 className="font-display text-lg font-semibold tracking-tight text-foreground">
                CGFlow
              </h1>
              <p className="text-[10px] font-medium uppercase text-muted-foreground">
                Molecular Opt.
              </p>
            </div>
            ) : null}
          </div>

          <div className="h-px bg-border" />

          {/* Navigation */}
          <nav className="space-y-1 px-3 py-4">
            {!isSidebarCollapsed ? (
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase text-muted-foreground/70">
              Workspace
            </p>
            ) : null}
            <NavItem
              icon={Settings}
              label="Configuration"
              active={activeTab === 'config'}
              onClick={() => setActiveTab('config')}
              collapsed={isSidebarCollapsed}
            />
            <NavItem
              icon={LayoutDashboard}
              label="Dashboard"
              active={activeTab === 'dashboard'}
              onClick={() => setActiveTab('dashboard')}
              collapsed={isSidebarCollapsed}
            />
          </nav>

          <div className="flex-1" />

          <div className="space-y-2 border-t border-border p-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-full"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {!isSidebarCollapsed ? (
                <span className="ml-2 text-sm">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-full"
              onClick={() => setIsSidebarCollapsed((current) => !current)}
              title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {isSidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              {!isSidebarCollapsed ? <span className="ml-2 text-sm">Collapse</span> : null}
            </Button>
          </div>

          {/* Run status at bottom of sidebar */}
          <div className="border-t border-border p-4">
            {!isSidebarCollapsed ? (
            <p className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground/70">
              Active Run
            </p>
            ) : null}
            {activeRun ? (
              <div className={`animate-fade-in ${isSidebarCollapsed ? 'flex justify-center' : 'space-y-2'}`}>
                {isSidebarCollapsed ? (
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/20 bg-primary/10"
                    title={`${activeRun.name}: ${activeRun.status}`}
                  >
                    <FlaskConical className="h-4 w-4 text-primary" />
                  </div>
                ) : (
                <>
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-3.5 w-3.5 text-primary" />
                  <span className="truncate text-sm font-medium text-foreground">
                    {activeRun.name}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <Badge variant={runStatusVariant} className="text-[10px]">
                    {activeRun.status}
                  </Badge>
                  <span className="font-data text-[11px] text-muted-foreground tabular-nums">
                    {activeRun.currentStep}/{activeRun.totalSteps}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-secondary">
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
                </>
                )}
              </div>
            ) : (
              <div className={`flex items-center gap-2 text-muted-foreground ${isSidebarCollapsed ? 'justify-center' : ''}`}>
                <Activity className="h-3.5 w-3.5" />
                {!isSidebarCollapsed ? <span className="text-xs">No active run</span> : null}
              </div>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <RunnerStatusBar />
          <div className="flex-1 overflow-hidden">
          <TabsContent value="config" className="m-0 h-full">
            <ConfigBuilder
              onConfigChange={setCurrentConfig}
              onRunStarted={setActiveRun}
              activeRun={activeRun}
            />
          </TabsContent>

          <TabsContent value="dashboard" className="m-0 h-full overflow-y-auto">
            <Dashboard
              activeRun={activeRun}
              onRunStatusChange={setActiveRun}
            />
          </TabsContent>
          </div>
        </main>
      </Tabs>
    </div>
  );
}
