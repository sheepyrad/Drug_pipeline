## Learned User Preferences

- Run FABind_plus (FABind) Python entry points in the conda environment named `fabind`, not only the main project env.
- On this machine, keep Hugging Face Hub model caches on the larger disk at `/media/data/conrad_hku/hf_cache` (use `flashbind.hf_hub_cache` / `HF_HUB_CACHE` where the pipeline supports it).
- For cgflow-gui, prefer ECharts via `echarts-for-react` over Plotly for charts and dashboards.
- For cgflow-gui web mode, type absolute file paths for inputs and outputs; do not rely on client-side file pickers for server-side paths.
- Prefer cgflow-gui config layout as a single column (Input PDB → Target residues → Opt params → Directories) for responsive scaling.

## Learned Workspace Facts

- `cgflow/` is a git submodule (not vendored in-tree); run `git submodule update --init --recursive` after clone.
- Create the CGFlow conda env with `mamba create -n cgflow python=3.11`, then install PyTorch/PyG and the package per root `README.md`.
- Start the desktop GUI from `cgflow-gui/` with `bun run electron:dev`; start web mode with `bun run dev:web` (expects `../cgflow` and the `cgflow` conda env).
- FlashBind optimization invokes FABind_plus scripts through `synthflow.utils.conda_env.run_in_conda_env`, using the `fabind` conda env for those subprocesses.
- FABind+ and FlashBind `.ckpt`/`.bin` weights are not in git; run `./scripts/setup-cgflow-assets.sh` (or `cgflow/scripts/setup/download_flashbind_assets.sh`) after submodule init.
- The FlashBind task supports `hf_hub_cache` so representation subprocesses (e.g. ESM3 downloads) can set `HF_HUB_CACHE` to a large-disk path.
- On Ubuntu 20.04 (glibc 2.31), use `torch==2.6.0+cu124` and PyG wheels from `torch-2.6.0+cu124.html`; torch 2.9.x+cu126 PyG wheels require GLIBC 2.32+.
- When installing `boltz[cuda]`, pin torch with a constraints file (see root `README.md`) so pip does not upgrade the PyTorch stack.
- Install cgflow editable from the submodule root (`pip install -e .`) so `src/` packages such as `rxnflow` resolve in scripts.
- On this machine, miniforge/conda envs and large artifacts live under `/media/data/conrad_hku/` (`miniforge3`, `cgflow_env`, `cgflow_web/result`, `hf_cache`).
- CGFlow runner write allowlist: set `CGFLOW_ALLOWED_WORKSPACE_PATHS` in `cgflow-gui/.env.local` for writable `/media/data/conrad_hku/...` paths (evaluated lazily after `.env.local` loads).
