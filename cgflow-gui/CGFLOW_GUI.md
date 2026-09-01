# CGFlow GUI — Architecture & Feature Reference

A hybrid Electron / Web application for configuring, launching, and monitoring **CGFlow** molecular optimization runs powered by **Boltz-2**. The GUI spawns Python processes locally, reads their SQLite output databases, and optionally syncs everything to a **Convex** cloud backend for cross-machine access and real-time dashboarding.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Project Structure](#project-structure)
3. [Running Modes](#running-modes)
4. [Pages & Features](#pages--features)
   - [Configuration Builder](#1-configuration-builder)
   - [Dashboard](#2-dashboard)
5. [Core Components](#core-components)
6. [How Python Processes Are Spawned](#how-python-processes-are-spawned)
   - [The Runner Server](#the-runner-server)
   - [Electron IPC (Legacy Path)](#electron-ipc-legacy-path)
   - [Process Lifecycle](#process-lifecycle)
7. [Convex Backend Integration](#convex-backend-integration)
   - [Schema](#convex-schema)
   - [What Gets Synced](#what-gets-synced)
   - [ConvexSyncService](#convexsyncservice)
   - [Frontend Hooks](#frontend-convex-hooks)
   - [Real-Time Subscriptions](#real-time-subscriptions)
8. [Data Flow End-to-End](#data-flow-end-to-end)
9. [Shared Types](#shared-types)
10. [Tech Stack](#tech-stack)

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          cgflow-gui                                  │
│                                                                      │
│  ┌──────────────┐     ┌────────────────┐     ┌───────────────────┐  │
│  │  React App   │────▶│  Runner Client │────▶│  Runner Server    │  │
│  │  (Renderer)  │     │  (HTTP client) │     │  (Node.js HTTP)   │  │
│  │              │     └────────────────┘     │  port 45731       │  │
│  │  - Config    │                            │                   │  │
│  │  - Dashboard │     ┌────────────────┐     │  spawn('python',  │  │
│  │  - Mol*      │────▶│  Convex Client │     │   opt_unidock_    │  │
│  │  - RDKit     │     │  (React hooks) │     │   boltz.py ...)   │  │
│  └──────┬───────┘     └───────┬────────┘     └────────┬──────────┘  │
│         │                     │                       │              │
│         │ IPC (Electron)      │ WebSocket             │ stdout/err   │
│         ▼                     ▼                       ▼              │
│  ┌──────────────┐     ┌────────────────┐     ┌───────────────────┐  │
│  │  Electron    │     │    Convex      │     │  cgflow Python    │  │
│  │  Main Proc   │     │    Cloud       │     │  process          │  │
│  │  (optional)  │     │                │     │                   │  │
│  └──────────────┘     │  - runs        │     │  Writes to:       │  │
│                       │  - molecules   │     │  - train.log      │  │
│  ┌──────────────┐     │  - files       │     │  - SQLite DBs     │  │
│  │  Convex Sync │────▶│  - annotations │     │  - checkpoints    │  │
│  │  Service     │     │                │     │  - Boltz outputs  │  │
│  │  (Node.js)   │     └────────────────┘     └───────────────────┘  │
│  └──────────────┘                                                    │
│         │                                                            │
│         │ Reads SQLite DBs every 30s                                 │
│         ▼                                                            │
│  ┌───────────────────────────────────────┐                           │
│  │  Local SQLite Databases               │                           │
│  │  - boltz_reward_cache.db              │                           │
│  │  - boltz_scores_0.db                  │                           │
│  │  - generated_objs_*.db                │                           │
│  └───────────────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
cgflow-gui/
├── src/                           # Frontend (React + Vite)
│   ├── main.tsx                   #   Entry point, Convex provider setup
│   ├── App.tsx                    #   Tab navigation (Config / Dashboard)
│   ├── pages/
│   │   ├── ConfigBuilder.tsx      #   Configuration form + Mol* viewer
│   │   └── Dashboard.tsx          #   Run monitoring + molecule analysis
│   ├── components/
│   │   ├── FileSelector.tsx       #   Local + Convex file picker
│   │   ├── MoleculeCard.tsx       #   2D molecule (RDKit SVG)
│   │   ├── MolstarViewer.tsx      #   3D protein viewer (Mol*)
│   │   ├── ReactionPathway.tsx    #   Reaction trajectory visualization
│   │   └── ui/                    #   shadcn/ui primitives
│   ├── hooks/
│   │   ├── useConvex.ts           #   Convex availability + runs
│   │   ├── useIpc.ts              #   IPC / Runner client abstraction
│   │   └── useUploadedFiles.ts    #   File upload to Convex storage
│   └── lib/
│       ├── runnerClient.ts        #   HTTP client for runner server
│       ├── utils.ts               #   cn() helper
│       └── webFallback.ts         #   Web-mode IPC shims
│
├── electron/                      # Electron main process
│   ├── main.ts                    #   Window creation, IPC handlers
│   ├── preload.ts                 #   Context bridge
│   ├── runner.ts                  #   Standalone HTTP runner server
│   └── convex-sync.ts             #   SQLite → Convex sync service
│
├── convex/                        # Convex backend functions
│   ├── schema.ts                  #   Database schema (4 tables)
│   ├── runs.ts                    #   Run lifecycle
│   ├── molecules.ts               #   Molecule upsert + queries
│   ├── files.ts                   #   File storage operations
│   └── annotations.ts             #   User annotations on molecules
│
├── shared/
│   └── types.ts                   #   Zod schemas shared across all layers
│
├── vite.config.ts                 #   Electron build (main + preload + runner)
├── vite.config.web.ts             #   Web-only build (no Electron)
├── package.json
└── convex.json
```

---

## Running Modes

The app supports two deployment modes:

| Mode | Command | Electron | Runner Server | Convex |
|------|---------|----------|---------------|--------|
| **Electron** | `npm run dev` / `bun run electron:dev` | Yes — full desktop app | Started automatically by Electron main process | Optional |
| **Web (full)** | `bun run dev:web` | No — browser-only | Started automatically alongside Vite | Optional |
| **Web (UI only)** | `bun run dev:web:ui` | No — browser-only | Must be started separately with `bun run dev:runner` | Optional |

In both Electron and web modes the React frontend communicates with the **Runner Server** over HTTP (`http://127.0.0.1:45731`). When Electron is present, IPC is available as a fallback. When Convex is configured (`VITE_CONVEX_URL`), data is also synced to the cloud.

In web mode, run-critical file/directory pickers are disabled. Users type runner-local paths for inputs and output directories, or use Convex uploads where supported. A runner status bar shows whether the local runner is ready, unavailable, or errored.

---

## Pages & Features

### 1. Configuration Builder

**Location:** `src/pages/ConfigBuilder.tsx`

A split-panel form for assembling a CGFlow optimization configuration.

| Section | Description |
|---------|-------------|
| **Load / Save** | Load YAML from disk, save YAML locally, save to Convex cloud |
| **Input Files** | Select Protein PDB, Boltz Base YAML, MSA path — via local filesystem or Convex uploads |
| **Target Residues** | Click-to-select residues in the Mol* viewer or type manually (format `A:123`) |
| **Directories** | Result directory and environment directory paths |
| **Optimization Params** | Steps, Samples/Step, Max Atoms, Seed, Temperature range, Pose model, etc. |
| **Run Controls** | Start Training / Stop buttons, live status badge, progress bar |

**Right panel:** An interactive **Mol\*** 3D protein viewer that:
- Loads the selected PDB file
- Highlights selected target residues
- Supports click-to-select (multi-select mode) for defining binding sites

**Config format** matches the CGFlow YAML schema (`OptConfig` in `shared/types.ts`) with nested `boltz` sub-config.

### 2. Dashboard

**Location:** `src/pages/Dashboard.tsx`

A monitoring and analysis view for active and completed runs.

| Area | Description |
|------|-------------|
| **Left sidebar** | Scrollable run history — shows all local + Convex runs with status icons and step progress. Click to select. Auto-refreshes every 5 seconds. |
| **KPI cards** (top) | 5 metric cards: Status, Progress, Best Affinity, Best Probability, Molecule Count |
| **Molecule detail** (left) | Selected molecule's 2D structure (RDKit), Boltz-2 scores (affinity/probability for ensemble + individual models), reaction trajectory pathway |
| **Mol\* viewer** (right) | 3D visualization of the Boltz-2 predicted protein-ligand complex for the selected molecule |
| **Molecule table** (bottom) | Top 50 molecules ranked by reward — columns: SMILES, Reward, Affinity, Probability, Steps. Click to select and inspect. |

**Data sources are merged:** the Dashboard combines local runs (from the Runner Server) with Convex cloud runs into a unified list. Each run is tagged with `source: 'local'` or `source: 'convex'`.

---

## Core Components

### `MolstarViewer` — 3D Protein Structure

- Embeds the [Mol\*](https://molstar.org/) WebGL viewer
- Loads PDB/MMCIF structures
- Interactive residue selection with highlighting
- Multi-select mode for binding site definition
- Used in both ConfigBuilder (residue selection) and Dashboard (complex viewing)

### `MoleculeCard` — 2D Molecule Rendering

- Renders SMILES via **RDKit.js** to SVG
- Shows reward score
- Copy-to-clipboard for SMILES strings

### `ReactionPathway` — Trajectory Visualization

- Displays the step-by-step build trajectory of a molecule
- Shows action names, fragment SMILES, and intermediate structures
- Animated timeline layout

### `FileSelector` — Unified File Picker

- Dropdown supporting both local file selection (via IPC dialog) and Convex cloud uploads
- Lists previously uploaded files per field type
- Upload/delete operations on Convex storage
- Falls back to local-only when Convex is unavailable

---

## How Python Processes Are Spawned

CGFlow's Python optimization script is invoked as a **child process** from Node.js. There are two code paths that can do this — both ultimately run the same command.

### The Runner Server

**Location:** `electron/runner.ts`

A standalone HTTP server (default port `45731`) that manages the full lifecycle of Python processes. It can run inside Electron or independently.

**Startup:**

```
server.listen(45731, '127.0.0.1')
```

**What it spawns:**

```
python  cgflow/scripts/opt/opt_boltz.py  \
  --config  <resolved_config.yaml>               \
  --result_dir  <result_dir>                      \
  --env_dir  <env_dir>
```

The script path is resolved relative to the runner:

```typescript
const CGFLOW_ROOT = path.resolve(__dirname, '../../cgflow');
const OPT_SCRIPT  = path.join(CGFLOW_ROOT, 'scripts/opt/opt_boltz.py');
```

**Resume runs** pass additional flags:

```
python  opt_boltz.py  --config <yaml>  --resume_from <checkpoint>  [--resume_oracle_idx N]
```

**Key REST endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/runs` | Start a new run — writes config YAML, spawns Python |
| `POST` | `/runs/:id/stop` | Send `SIGINT` to the Python process (graceful pause) |
| `POST` | `/runs/:id/resume` | Resume from a checkpoint |
| `GET`  | `/runs` | List all runs |
| `GET`  | `/runs/:id` | Get single run status |
| `GET`  | `/runs/:id/output` | Get process stdout/stderr |
| `GET`  | `/runs/:id/checkpoints` | List available checkpoints |
| `GET`  | `/runs/:id/molecules` | Query top molecules from SQLite |
| `GET`  | `/runs/:id/complex/:oracle/:mol` | Get Boltz complex structure file |
| `GET`  | `/events` | SSE stream for real-time status updates |
| `GET`  | `/health` | Health check |

### Electron IPC (Legacy Path)

**Location:** `electron/main.ts`

The Electron main process registers IPC handlers (`run:start`, `run:stop`, `run:resume`) that can also spawn the same Python script directly via `child_process.spawn()`. This path is used when the Runner Server is unavailable.

### Process Lifecycle

```
┌─────────┐   POST /runs    ┌───────────────┐   spawn()   ┌──────────────┐
│  React   │───────────────▶│ Runner Server │────────────▶│   Python     │
│  UI      │                │               │             │  opt_unidock │
└─────────┘                │               │◀────────────│  _boltz.py   │
                           │               │  stdout/err  └──────────────┘
     SSE /events           │               │                    │
◀──────────────────────────│  Broadcasts   │                    │
                           │  status via   │                    ▼
                           │  SSE events   │            ┌──────────────┐
                           │               │            │  SQLite DBs  │
                           └───────────────┘            │  train.log   │
                                  │                     │  checkpoints │
                                  │ reads SQLite        └──────────────┘
                                  │ on demand
                                  ▼
                           Returns molecules,
                           scores, complex files
```

1. **Start:** The frontend sends the `OptConfig` to `POST /runs`. The runner writes a temporary YAML config, spawns the Python process, and returns a `RunInfo` object with a unique `runId`.

2. **Monitor:** `stdout` and `stderr` are captured line-by-line. The runner parses output for progress markers (e.g., `[Step X/Y]`, `Saved checkpoint`). Status updates are broadcast over SSE to all connected clients.

3. **Stop:** `POST /runs/:id/stop` sends `SIGINT` to the child process. The process status is set to `paused`. The checkpoint path is preserved so the run can be resumed later.

4. **Resume:** `POST /runs/:id/resume` spawns a new Python process with `--resume_from <checkpoint>`.

5. **Complete:** When the process exits with code 0, the status is set to `completed`. Non-zero exit sets `error` status with the exit code.

6. **Data Access:** The runner reads SQLite databases written by the Python process to serve molecule data, Boltz scores, and complex structures on demand.

### State Management

The runner maintains in-memory state:

```typescript
interface RunnerState {
  runs:      Map<string, RunRecord>;     // Run metadata & status
  outputs:   Map<string, string[]>;      // Captured stdout/stderr lines
  processes: Map<string, ChildProcess>;  // Active Node.js child processes
}
```

Run metadata is persisted to a JSON file (`runs.json`) in the runner's data directory so runs survive server restarts.

---

## Convex Backend Integration

Convex is an **optional** cloud backend. When configured (via `VITE_CONVEX_URL`), it provides:

- **Cross-machine access** — view runs and molecules from any browser
- **Real-time updates** — Convex subscriptions push data to the UI automatically
- **Cloud file storage** — upload PDB/YAML/MSA files to Convex storage

When Convex is not configured, the app operates in local-only mode with full functionality via the Runner Server.

### Convex Schema

**Location:** `convex/schema.ts`

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `runs` | Training run records (status, progress, result dir) | `by_status` |
| `molecules` | Generated molecules synced from local SQLite | `by_run`, `by_run_reward`, `by_smiles` |
| `files` | Uploaded files (PDB, YAML, MSA) with Convex storage refs | `by_run`, `by_type`, `by_field_type` |
| `annotations` | User notes, stars, and tags on molecules | `by_molecule` |

### What Gets Synced

The `ConvexSyncService` (`electron/convex-sync.ts`) runs in the Node.js layer and periodically pushes local data to Convex:

| Data Source | Sync Target | Frequency | Mechanism |
|-------------|-------------|-----------|-----------|
| `boltz_reward_cache.db` | `molecules` table | Every 30 seconds | Reads SQLite → `api.molecules.batchUpsert` |
| `boltz_scores_0.db` | `molecules` table (score fields) | Every 30 seconds | Joined with reward cache entries |
| `generated_objs_*.db` | `molecules` table (trajectory field) | Every 30 seconds | Trajectory JSON extracted per SMILES |
| `train.log` | `runs` table (currentStep) | Every 30 seconds | Parses last iteration number |
| Run status changes | `runs` table | On event | Immediate push on start/stop/complete/error |
| File uploads | `files` table + `_storage` | On upload | 3-step: generateUrl → POST blob → create record |

### ConvexSyncService

**Location:** `electron/convex-sync.ts`

A singleton service that uses `ConvexHttpClient` (non-React, server-side client) to push data.

**Key methods:**

| Method | Description |
|--------|-------------|
| `startSync(runId, convexRunId, resultDir)` | Begin periodic sync (every 30s) for a run |
| `stopSync(runId)` | Stop periodic sync |
| `createRun(name, resultDir, totalSteps)` | Create a run record in Convex |
| `updateRunStatus(convexRunId, status, ...)` | Push status change to Convex |
| `syncMolecules(convexRunId, resultDir)` | Read SQLite DBs → batch upsert molecules |
| `syncRunStatus(convexRunId, resultDir)` | Parse `train.log` → update step count |
| `uploadFile(filePath, fileType)` | Upload a local file to Convex storage |

**Molecule sync process in detail:**

1. Open `boltz_reward_cache.db` — query top 1000 entries by reward
2. Scan `generated_objs_*.db` files in `train/` — extract trajectory JSON per SMILES
3. Open `boltz_scores_0.db` — join Boltz affinity/probability scores per SMILES
4. Parse `info` JSON from reward cache — extract `oracle_idx` and `mol_idx`
5. Assemble molecule objects and call `api.molecules.batchUpsert`

### Frontend Convex Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useConvexAvailable()` | `hooks/useConvex.ts` | Check if Convex is configured and reachable |
| `useConvexRuns()` | `hooks/useConvex.ts` | Subscribe to `api.runs.list` — returns null if unavailable |
| `useUploadedFiles(fieldType)` | `hooks/useUploadedFiles.ts` | Upload/list/delete files by field type (protein_pdb, boltz_yaml, msa) |
| `useAllUploadedFiles()` | `hooks/useUploadedFiles.ts` | Browse all uploaded files |

### Real-Time Subscriptions

The frontend uses Convex's `useQuery` hooks which maintain **WebSocket subscriptions**. When data changes server-side, the UI updates automatically — no polling needed for Convex data.

- `api.molecules.getTopByRun` — Dashboard molecule table auto-updates as sync pushes new molecules
- `api.runs.list` — Run history sidebar reflects status changes in real-time
- `api.files.listByFieldType` — File selector shows newly uploaded files

---

## Data Flow End-to-End

### 1. Configure & Start a Run

```
User fills form in ConfigBuilder
        │
        ▼
OptConfig object assembled (Zod-validated)
        │
POST /runs → Runner Server
        │
        ├──▶ Write config to temp YAML file
        ├──▶ Create Convex run (ConvexSyncService.createRun) [optional]
        ├──▶ spawn('python', ['opt_boltz.py', ...])
        │
        ▼
Python process starts, writing to result_dir/
```

### 2. Monitor Progress

```
Python writes to stdout ──▶ Runner captures lines ──▶ SSE broadcast
Python writes train.log ──▶ ConvexSync reads log   ──▶ api.runs.updateStatus
Python writes SQLite DBs ──▶ ConvexSync reads DBs  ──▶ api.molecules.batchUpsert
                                                           │
                                                           ▼
                                              Convex useQuery subscriptions
                                              auto-update Dashboard UI
```

### 3. View Results

```
Dashboard selects run
        │
        ├──▶ Local run: GET /runs/:id/molecules → reads SQLite on demand
        │
        ├──▶ Convex run: useQuery(api.molecules.getTopByRun) → real-time
        │
        ▼
Molecules displayed in table
        │
User clicks molecule
        │
        ├──▶ 2D structure rendered via RDKit.js
        ├──▶ Boltz scores displayed
        ├──▶ Reaction trajectory visualized
        └──▶ 3D complex loaded in Mol* (GET /runs/:id/complex/:oracle/:mol)
```

### 4. Convex File Resolution

When a config references a Convex-uploaded file (format `convex://fileId::filename`):

```
Runner receives config with convex:// path
        │
        ▼
resolveConvexFile(path)
        │
        ├──▶ api.files.getUrl(fileId) → get download URL
        ├──▶ fetch(url) → download file content
        ├──▶ Write to local temp file
        └──▶ Return local path for Python to use
```

---

## Shared Types

**Location:** `shared/types.ts`

All layers (frontend, Electron main, runner, Convex) share Zod-validated type definitions:

| Type | Description |
|------|-------------|
| `OptConfig` | Full optimization config (matches YAML schema) |
| `BoltzConfig` | Nested Boltz-2 sub-config |
| `RunInfo` | Run metadata (id, status, progress, paths) |
| `RunStatus` | `'idle' \| 'running' \| 'paused' \| 'completed' \| 'error'` |
| `MoleculeResult` | Molecule with scores, trajectory, and complex path |
| `BoltzScore` | Affinity/probability scores from Boltz-2 |
| `RewardCacheEntry` | SMILES + reward from the reward cache DB |
| `TrajectoryStep` | Single step in a molecule's build trajectory |
| `GeneratedObject` | Raw generated molecule from SQLite |
| `IpcChannels` | Type-safe IPC channel definitions |
| `IpcEvents` | Type-safe event definitions (main → renderer) |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18, TypeScript 5.7, Vite 5 |
| **UI** | Tailwind CSS, shadcn/ui (Radix primitives), Framer Motion |
| **3D Viewer** | Mol* (Molstar 4.5) |
| **2D Chemistry** | RDKit.js |
| **Desktop** | Electron 34 |
| **Backend** | Convex 1.17 (optional cloud) |
| **Process Mgmt** | Node.js `child_process.spawn` |
| **Local Data** | SQLite via sql.js |
| **Validation** | Zod 3.24 |
| **Config Format** | YAML (via `yaml` package) |
