# CGFlow GUI

Desktop-first GUI for running and analyzing CGFlow + Boltz-2 optimization jobs.

The app provides:
- a visual config builder,
- local run orchestration,
- live monitoring and molecule analysis,
- optional Convex cloud sync for cross-machine access.

## What This App Does

CGFlow GUI is split across four layers:

1. **React Renderer (`src/`)** for config editing, dashboards, Mol* views, and molecule cards.
2. **Runner Service (`electron/runner.ts`)** that starts/stops/resumes CGFlow Python jobs and serves run data over HTTP/SSE.
3. **Electron Main (`electron/main.ts`)** for desktop shell, IPC, tray integration, and bootstrapping.
4. **Convex Backend (`convex/`)** for optional cloud persistence of runs, files, molecules, and annotations.

## Key Features

- **Configuration Builder**: Build/edit YAML-equivalent optimization configs.
- **Mol* Residue Selection**: Click residues in 3D protein view to set target residues.
- **Run Lifecycle Management**: Start, stop (pause), resume, and checkpoint-aware workflows.
- **Results Dashboard**: Inspect run progress, top molecules, Boltz scores, and trajectory pathways.
- **Protein-Ligand Complex Viewer**: Load predicted complex structures for selected molecules.
- **Cloud Sync (Optional)**: Persist files/runs/molecules with Convex.

## Prerequisites

- Bun
- Node.js 18+ available for Electron tooling
- Python 3.10+
- Conda env with CGFlow dependencies (default env name: `cgflow`)
- CGFlow repository available at `../cgflow` relative to this project
- Convex account (optional)

## Installation

From the repository root:

```bash
cd cgflow-gui
bun install
```

The desktop app starts CGFlow jobs through the local conda environment. By default it runs Python with:

```bash
conda run --no-capture-output -n cgflow python ...
```

Set `CGFLOW_CONDA_ENV` if your environment uses a different name.

### Optional Convex Setup

Convex is only needed for cloud sync. Local desktop runs and dashboards work without it.

```bash
bunx convex dev
```

If Convex is enabled, set `VITE_CONVEX_URL` or `CONVEX_URL` in `.env`.

## Running the App

### Desktop (recommended)

```bash
bun run electron:dev
```

This starts:
- Vite renderer dev server
- Electron main process
- local runner service (started by Electron on app boot)

### Web mode (browser + local runner)

```bash
bun run dev:web
```

This starts:
- Vite web UI (`dev:web:ui`)
- local runner service (`dev:runner`) on `http://127.0.0.1:45731` by default

Use this when developing in the browser without Electron. The UI talks to the runner over HTTP, not IPC.

For UI-only development without the runner:

```bash
bun run dev:web:ui
```

Web mode does not expose the browser filesystem to the runner. Type runner-local input/output paths in the Configuration form, or use Convex uploads (`convex://...`) where supported.

For npm/Node environments without Bun, run the runner with `npx tsx electron/runner.ts` instead of `bun run dev:runner`.

Training/run operations still require the local CGFlow setup, conda envs, and filesystem access on the machine running the runner.

### npm fallback

If Bun is unavailable, the same scripts can be run with npm:

```bash
npm install
npm run electron:dev
```

## Build

```bash
bun run build
```

Artifacts are generated in:
- `dist/` (renderer)
- `dist-electron/` (main/preload/runner)
- `release/` (packaged app)

## Environment Variables

Create `.env` in `cgflow-gui/` as needed:

```env
# Optional Convex deployment URL
VITE_CONVEX_URL=https://your-deployment.convex.cloud

# Optional toggle (default true)
VITE_CONVEX_ENABLED=true

# Optional runner URL override (default shown)
VITE_RUNNER_URL=http://127.0.0.1:45731

# Optional conda env override in main/runner process
CGFLOW_CONDA_ENV=cgflow
```

In PowerShell, you can also set the conda environment for the current terminal session before launching the app:

```powershell
$env:CGFLOW_CONDA_ENV="cgflow"
bun run electron:dev
```

## Typical Workflow

1. Open **Configuration** tab.
2. Load/create config and select files:
   - protein `.pdb`
   - optional MSA file (if provided, injected into generated Boltz base YAML)
3. Select target residues in Mol* (or enter manually as `CHAIN:RESID`, e.g. `A:123`).
4. Set optimization parameters and directories.
5. Start training.
6. Open **Dashboard** to monitor KPIs and inspect molecules.
7. Select a molecule to view:
   - RDKit 2D structure,
   - Boltz affinity/probability metrics,
   - reaction pathway,
   - predicted protein-ligand complex in Mol*.

## Project Structure

```text
cgflow-gui/
├── electron/
│   ├── main.ts          # Electron main process + IPC
│   ├── preload.ts       # Context bridge for renderer
│   ├── runner.ts        # Local HTTP/SSE runner service
│   └── convex-sync.ts   # SQLite -> Convex sync service
├── src/
│   ├── pages/           # ConfigBuilder + Dashboard
│   ├── components/      # MolstarViewer, FileSelector, MoleculeCard, etc.
│   ├── hooks/           # IPC, Convex, uploads, run state helpers
│   └── lib/             # Runner client, utilities
├── shared/
│   └── types.ts         # Shared zod schemas/types for app layers
└── convex/
    ├── schema.ts        # Convex schema
    ├── runs.ts          # Run records/status
    ├── molecules.ts     # Molecule upserts/queries
    ├── files.ts         # File storage metadata + upload URLs
    └── annotations.ts   # Molecule annotations
```

## Data and Output Expectations

CGFlow writes run outputs into the configured `result_dir`, including:
- checkpoint files (`model_state_*.pt`)
- logs
- SQLite databases used by the dashboard and sync (`boltz_reward_cache.db`, `boltz_scores_0.db`, `generated_objs_*.db`)
- Boltz complex output files (CIF/PDB) used for 3D viewing

## Troubleshooting

- **Runner unavailable / cannot start runs**
  - In web mode, run `bun run dev:web` (UI + runner) or start the runner separately with `bun run dev:runner`.
  - If you see `Port 45733 is in use`, a previous runner may still be running. Stop it with `fuser -k 45733/tcp` (or your configured port), or set `CGFLOW_RUNNER_REUSE=1` to attach to the existing runner instead of starting a new one.
  - `bun run dev:web` starts the runner as a sibling process; Ctrl+C should stop both the Vite UI and the runner together.
  - When using a relative `VITE_RUNNER_URL` like `/runner-api`, the Vite dev server proxies requests to the local runner port configured by `CGFLOW_RUNNER_PORT`.
  - Check the runner status bar in the UI and confirm the service is reachable at `VITE_RUNNER_URL`.
  - In Electron desktop mode, ensure the app is running so Electron can start the embedded runner.
- **Python process fails immediately**
  - Verify `CGFLOW_CONDA_ENV` and that `opt_boltz.py` is available under `../cgflow/scripts/opt/`.
- **No molecules in dashboard yet**
  - Wait for CGFlow to emit SQLite outputs; early run stages may have no molecules.
- **Convex actions disabled**
  - Set a valid `VITE_CONVEX_URL` and run `bunx convex dev` (or deploy and point to a production URL).

## Tech Stack

- Electron
- React 18 + TypeScript
- Vite
- Tailwind CSS + shadcn/ui
- Framer Motion
- Mol*
- RDKit.js
- sql.js
- Convex (optional)
- Zod + YAML

## License

MIT
