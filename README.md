# BioSmart

Monorepo for CGFlow molecular optimization, the CGFlow GUI (Electron + web), and FlashBind integration.

## CGFlow setup

CGFlow lives in `cgflow/` as a git submodule ([sheepyrad/cgflow](https://github.com/sheepyrad/cgflow.git)), on branch `feat/flashbind-integration` (Boltz + FlashBind backends).

```bash
git submodule update --init --recursive
cd cgflow

# 1. Create and activate environment using mamba
mamba create -n cgflow python=3.11
mamba activate cgflow

# 2. Install PyTorch + PyG via pip
# Ubuntu 20.04 (glibc 2.31): use torch 2.6.0 + cu124 — PyG wheels for torch 2.9.x
# require glibc 2.32+ and will fail to import torch_scatter.
pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cu124

pip install \
    torch-geometric>=2.4.0 \
    torch-scatter>=2.1.2 \
    torch-sparse>=0.6.18 \
    torch-cluster>=1.6.3 \
    -f https://data.pyg.org/whl/torch-2.6.0+cu124.html

# 3. Install cgflow (editable)
pip install -e .

# 4. Optional extras
# AutoDock Vina
pip install -e '.[vina]'
# Unidock (GPU-accelerated docking)
mamba install unidock
pip install -e '.[unidock]'
# Jupyter and other extras
mamba install notebook
pip install -e '.[extra]'

# 5. Boltz with CUDA — pin torch so pip does not upgrade it (boltz requires torch>=2.2)
printf 'torch==2.6.0\n' > /tmp/cgflow-constraints.txt
pip install 'boltz[cuda]' -c /tmp/cgflow-constraints.txt
```

See `cgflow/README.md` for Ubuntu 22.04+ (newer torch/PyG) notes and why `-U` must be avoided when installing Boltz.

Prepare data, environment files, and pretrained CGFlow pose weights per `cgflow/README.md` and `cgflow/experiments/README.md`.

### FlashBind / FABind+ weights (required for FlashBind opt)

Large checkpoints are **not** in git. Download from Hugging Face after install:

```bash
# from repo root
./scripts/setup-cgflow-assets.sh

# or from cgflow/
cd cgflow && ./scripts/setup/download_flashbind_assets.sh
```

This fetches:

| Asset | Hugging Face | Local path |
|-------|--------------|------------|
| FABind+ | [KyGao/FABind_plus_model](https://huggingface.co/KyGao/FABind_plus_model) | `cgflow/src/FlashBind/FABind_plus/ckpt/` |
| FlashBind heads | [clorf6/FlashBind](https://huggingface.co/clorf6/FlashBind) | `cgflow/src/FlashBind/checkpoints/` |

FABind+ docking also needs the `fabind` conda env (`cgflow/src/FlashBind/FABind_plus/README.md`). FlashBind scoring uses `flashaffinity` (`cgflow/src/FlashBind/env.yaml`).

### Boltz optimization (NS5 example)

```bash
cd cgflow
python scripts/opt/opt_boltz.py --config ./configs/opt/NS5_crop_boltz_32_2000.yaml
```

### FlashBind optimization (NS5 example)

```bash
cd cgflow
python scripts/opt/opt_flashbind.py --config ./configs/opt/NS5_crop_flashbind_32_2000.yaml
```

## CGFlow GUI (local Electron)

```bash
cd cgflow-gui
bun install
bun run electron:dev
```

The GUI expects CGFlow at `../cgflow` and uses the `cgflow` conda environment by default. Override with `CGFLOW_CONDA_ENV` if needed.

See `cgflow-gui/README.md` and `cgflow-gui/CGFLOW_GUI.md` for architecture and development notes.

## Clone with submodules

```bash
git clone --recurse-submodules <repo-url>
# or after clone:
git submodule update --init --recursive
./scripts/setup-cgflow-assets.sh
```
