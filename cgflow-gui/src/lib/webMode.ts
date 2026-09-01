import type { OptConfig } from '@shared/types';
import { isElectron } from '@/lib/webFallback';

export function isWebMode(): boolean {
  return !isElectron();
}

/** Trim accidental whitespace from typed filesystem paths. */
export function normalizeRunnerPathInput(value: string): string {
  return value.trim();
}

export function isWebOnlyPath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('web://');
}

export function isRunnerReadablePath(value: string | null | undefined): boolean {
  if (!value) return true;
  if (isWebOnlyPath(value)) return false;
  return true;
}

export function validateRunnerReadablePaths(config: OptConfig): string | null {
  const checks: Array<{ label: string; value: string | null | undefined }> = [
    { label: 'Protein PDB', value: config.protein_path },
    { label: 'Reference ligand', value: config.ref_ligand_path },
    { label: 'Pose model', value: config.pose_model },
    { label: 'Result directory', value: config.result_dir },
    { label: 'Environment directory', value: config.env_dir },
    { label: 'MSA file', value: config.boltz.msa_path },
    { label: 'FlashBind prots_json', value: config.flashbind?.prots_json },
    { label: 'FlashBind protein_repr', value: config.flashbind?.protein_repr },
    { label: 'FlashBind ligand_repr', value: config.flashbind?.ligand_repr },
    { label: 'FlashBind fabind_checkpoint', value: config.flashbind?.fabind_checkpoint },
  ];

  for (const check of checks) {
    if (check.value && isWebOnlyPath(check.value)) {
      return `${check.label} uses a browser-only path. Type a runner-local path instead.`;
    }
  }

  return null;
}
