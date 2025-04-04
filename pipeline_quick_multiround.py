#!/usr/bin/env python
"""
Multi-round quick pipeline for de novo drug discovery.

Streamlined workflow with the ability to run multiple rounds:
  1. Ligand Generation (same as previous pipeline)
  2. Convert SDF to SMILES strings
  3. Run retrosynthesis (Synformer) on each compound
  4. Extract top N variants from retrosynthesis results
  5. Apply medchem filtering to the variants
  6. Redock filtered variants to the receptor
  7. Optionally iterate for multiple rounds, using top compounds from previous rounds

The quick pipeline skips energy minimization, posebuster evaluation, 
and other intermediate steps to provide faster results. With the added
multi-round capability, the pipeline can iteratively improve compounds
over several generations.
"""

import os
import sys
import time
from pathlib import Path
import logging
import pandas as pd
import shutil
from rdkit import Chem
import tempfile
import multiprocessing
from multiprocessing import Process, Queue
from contextlib import contextmanager
import queue
import threading
import json
from datetime import datetime
from typing import List

# Get logger for this module
logger = logging.getLogger(__name__)

# Set up thread-safe logging with QueueHandler and QueueListener
class ThreadSafeRotatingFileHandler(logging.FileHandler):
    """A file handler that is thread-safe and properly handles file descriptor issues"""
    def __init__(self, filename, mode='a', encoding=None, delay=False):
        super().__init__(filename, mode, encoding, delay)
        self._lock = threading.RLock()
        
    def emit(self, record):
        with self._lock:
            try:
                super().emit(record)
            except Exception:
                # If there's an error with the file descriptor, reopen the file
                try:
                    self.close()
                    self.stream = self._open()
                    super().emit(record)
                except Exception:
                    self.handleError(record)

# Import functions from the utils modules
from utils.ligand_generation import run_ligand_generation
from utils.redocking import redock_compound, vfu_dir
from utils.retrosynformer import run_retrosynthesis
from utils.medchem_filter import generative_filter, filter_compounds

def extract_smiles_from_sdf(sdf_file):
    """
    Extract SMILES strings from an SDF file.
    
    Args:
        sdf_file: Path to the SDF file
        
    Returns:
        List of dicts with compound_id and smiles
    """
    compounds = []
    try:
        # Read molecules from SDF
        supplier = Chem.SDMolSupplier(str(sdf_file))
        
        for idx, mol in enumerate(supplier):
            if mol is not None:
                # Generate compound ID based on the file name and index
                compound_id = f"{sdf_file.stem}_mol_{idx+1}"
                smiles = Chem.MolToSmiles(mol)
                compounds.append({"compound_id": compound_id, "smiles": smiles})
    except Exception as e:
        logger.error(f"Error extracting SMILES from SDF: {e}")
    
    logger.info(f"Extracted {len(compounds)} SMILES strings from {sdf_file}")
    return compounds

def extract_variants_from_retrosynthesis(retro_result_file, max_variants=5):
    """
    Extract synthetic variants from a retrosynthesis result file.
    
    Args:
        retro_result_file: Path to the CSV file with retrosynthesis results
        max_variants: Maximum number of variants to extract
        
    Returns:
        List of dicts with variant_id and smiles
    """
    variants = []
    try:
        # Read retrosynthesis results
        df = pd.read_csv(retro_result_file)
        
        if df.empty:
            logger.warning(f"Empty retrosynthesis results file: {retro_result_file}")
            return variants
        
        # Find the SMILES column (should be 'smiles' but check alternatives)
        smiles_col = None
        if 'smiles' in df.columns:
            smiles_col = 'smiles'
        else:
            # Look for a column that might contain SMILES strings
            for col in df.columns:
                if df[col].dtype == 'object' and any(c for c in df[col].iloc[0] if c in '()=#@'):
                    smiles_col = col
                    break
        
        if smiles_col is None:
            logger.error(f"No SMILES column found in {retro_result_file}")
            return variants
        
        # Try to sort by a score column if it exists to get the best variants
        if 'score' in df.columns:
            # Determine if higher or lower score is better (assuming higher is better by default)
            # NOTE: If your scores are like energy where lower is better, reverse the sort
            df = df.sort_values('score', ascending=False)
            logger.info(f"Sorting variants by 'score' column (higher is better)")
        
        # Extract up to max_variants
        for idx, row in df.head(max_variants).iterrows():
            smiles = row[smiles_col]
            # Get score if available for labeling
            score_text = ""
            if 'score' in df.columns:
                score = row['score']
                if not pd.isna(score):
                    score_text = f"_score{score:.3f}"
            
            # Create variant ID based on the original compound and variant number
            parent_id = retro_result_file.stem
            variant_id = f"{parent_id}_variant_{idx+1}{score_text}"
            
            variants.append({
                "variant_id": variant_id, 
                "smiles": smiles, 
                "parent_id": parent_id,
                "score": float(row['score']) if 'score' in df.columns and not pd.isna(row['score']) else None
            })
    
    except Exception as e:
        logger.error(f"Error extracting variants from {retro_result_file}: {e}")
    
    logger.info(f"Extracted {len(variants)} variants from {retro_result_file}")
    return variants

def smiles_to_sdf(smiles_list, output_file):
    """
    Convert a list of SMILES strings to an SDF file.
    
    Args:
        smiles_list: List of dicts with 'smiles' and ID ('variant_id' or other id field)
        output_file: Path to save the SDF file
        
    Returns:
        Path to the created SDF file or None if failed
    """
    try:
        writer = Chem.SDWriter(str(output_file))
        
        for item in smiles_list:
            smiles = item['smiles']
            
            # Get the ID (could be compound_id, variant_id, etc.)
            id_field = next((k for k in item.keys() if k.endswith('_id')), None)
            id_value = item.get(id_field, "unknown")
            
            mol = Chem.MolFromSmiles(smiles)
            if mol:
                # Add properties to the molecule
                mol.SetProp("_Name", id_value)
                mol.SetProp("SMILES", smiles)
                
                # Add barcode and tracking information
                if 'barcode' in item:
                    mol.SetProp("BARCODE", item['barcode'])
                if 'parent_id' in item:
                    mol.SetProp("PARENT_ID", item['parent_id'])
                if 'source_compound' in item:
                    mol.SetProp("SOURCE_COMPOUND", item['source_compound'])
                if 'generation' in item:
                    mol.SetProp("GENERATION", item['generation'])
                
                writer.write(mol)
            else:
                logger.warning(f"Could not convert SMILES to molecule: {smiles}")
        
        writer.close()
        logger.info(f"Created SDF file with {len(smiles_list)} molecules: {output_file}")
        return output_file
    
    except Exception as e:
        logger.error(f"Error converting SMILES to SDF: {e}")
        return None

def apply_medchem_filtering_to_variants(variants, output_dir):
    """
    Apply medchem filtering to variant SMILES.
    
    Args:
        variants: List of variant dictionaries with SMILES
        output_dir: Directory to save temporary files and results
        
    Returns:
        List of filtered variants
    """
    if not variants:
        logger.warning("No variants provided for filtering")
        return []

    try:
        # Create a temporary SDF file with all variants
        temp_sdf = output_dir / "temp_variants_for_filtering.sdf"
        if not smiles_to_sdf(variants, temp_sdf):
            logger.error("Failed to create temporary SDF file for filtering")
            return []
        
        # Apply MedChem filtering
        logger.info(f"Applying MedChem filtering to {len(variants)} variants...")
        filtered_df = generative_filter(temp_sdf, output_folder=output_dir)
        
        if filtered_df is None or filtered_df.empty:
            logger.warning("No variants passed MedChem filtering")
            return []
        
        # Create a mapping of SMILES to original variant data
        smiles_to_variant = {v['smiles']: v for v in variants}
        
        # Create a list for filtered variants
        filtered_variants = []
        
        # Check if SMILES column exists in filtered results
        smiles_col = None
        for possible_col in ['SMILES', 'smiles', 'canonical_smiles']:
            if possible_col in filtered_df.columns:
                smiles_col = possible_col
                break
        
        if not smiles_col:
            logger.error(f"Could not find SMILES column in filtered results. Available columns: {filtered_df.columns.tolist()}")
            return []
        
        # Match filtered compounds back to original variants
        for _, row in filtered_df.iterrows():
            smiles = row[smiles_col]
            if smiles in smiles_to_variant:
                variant = smiles_to_variant[smiles]
                # Add any additional properties from filtering if needed
                if 'filter_score' in row:
                    variant['filter_score'] = row['filter_score']
                filtered_variants.append(variant)
                logger.debug(f"Matched filtered variant: {variant.get('variant_id', 'unknown')} (Barcode: {variant.get('barcode', 'unknown')})")
        
        logger.info(f"MedChem filtering complete: {len(filtered_variants)} variants passed filtering out of {len(variants)}")
        return filtered_variants
    
    except Exception as e:
        logger.error(f"Error during MedChem filtering: {e}")
        return []
    
    finally:
        # Clean up temporary files
        if 'temp_sdf' in locals() and temp_sdf.exists():
            try:
                temp_sdf.unlink()
            except Exception as e:
                logger.warning(f"Failed to delete temporary SDF file: {e}")

def generate_tracking_report(compounds, variants, redock_results, out_dir):
    """
    Generate a comprehensive report showing the lineage of all compounds.
    
    Args:
        compounds: List of original generated compounds
        variants: List of variants from retrosynthesis
        redock_results: List of final docking results
        out_dir: Directory to save the report
    """
    try:
        # Create a comprehensive dataframe tracing all compounds
        report_rows = []
        
        # Add original compounds
        for comp in compounds:
            row = {
                'compound_id': comp.get('compound_id', 'unknown'),
                'barcode': comp.get('barcode', 'unknown'),
                'generation': comp.get('generation', '1'),
                'round': comp.get('round', 1),
                'smiles': comp.get('smiles', ''),
                'parent_id': 'NONE',
                'status': 'GENERATED',
                'source': 'AI_GENERATION'
            }
            report_rows.append(row)
        
        # Add all variants
        for var in variants:
            row = {
                'compound_id': var.get('variant_id', 'unknown'),
                'barcode': var.get('barcode', 'unknown'),
                'generation': var.get('generation', '2'),
                'round': var.get('round', 1),
                'smiles': var.get('smiles', ''),
                'parent_id': var.get('source_compound', 'unknown'),
                'parent_barcode': next((c.get('barcode') for c in compounds if c.get('compound_id') == var.get('source_compound')), 'unknown'),
                'status': 'SYNTHETIZED',
                'source': 'RETROSYNTHESIS',
                'score': var.get('score', None)
            }
            report_rows.append(row)
        
        # Update status for successfully docked variants
        docked_barcodes = {result.get('barcode') for result in redock_results}
        for row in report_rows:
            if row['barcode'] in docked_barcodes:
                row['status'] = 'DOCKED'
                
                # Find the docking score
                for result in redock_results:
                    if result.get('barcode') == row['barcode']:
                        # Extract best docking score and pose from pose_pred_out
                        if 'pose_pred_out' in result and result['pose_pred_out'] is not None:
                            try:
                                best_score, best_pose = extract_best_pose_and_score(result['pose_pred_out'])
                                if best_score is not None:
                                    row['docking_score'] = best_score
                                if best_pose is not None:
                                    row['best_pose'] = best_pose
                            except Exception as e:
                                logger.warning(f"Error extracting pose data for {row['barcode']}: {e}")
                        # Fallback to re_scored_values if pose_pred_out processing fails
                        elif 're_scored_values' in result and result['re_scored_values'] is not None:
                            try:
                                docking_score = result['re_scored_values'].split(',')[0]
                                row['docking_score'] = float(docking_score)
                            except Exception as e:
                                logger.warning(f"Error extracting re_scored_values for {row['barcode']}: {e}")
        
        # Create the report DataFrame
        report_df = pd.DataFrame(report_rows)
        
        # Save to CSV
        report_file = out_dir / "compound_tracking_report.csv"
        report_df.to_csv(report_file, index=False)
        logger.info(f"Compound tracking report saved to: {report_file}")
        
        # Return the dataframe for further use if needed
        return report_df
    
    except Exception as e:
        logger.error(f"Error generating tracking report: {e}")
        return None

def extract_best_pose_and_score(pose_pred_str):
    """
    Extract the best docking pose and score from the pose prediction output.
    
    Args:
        pose_pred_str: String or dict representation of pose prediction output
        
    Returns:
        Tuple of (best_score, best_pose_name)
    """
    try:
        # Convert string representation to dictionary
        import ast
        
        # Check if the pose_pred_str is already a dictionary
        if isinstance(pose_pred_str, dict):
            pose_dict = pose_pred_str
        elif pose_pred_str is None:
            return None, None
        else:
            # Try to safely evaluate the string representation
            pose_dict = ast.literal_eval(pose_pred_str)
        
        # Find the pose with the best (lowest) score
        best_score = float('inf')
        best_pose = None
        
        for pose_name, pose_data in pose_dict.items():
            # The pose_data is a list where the first element is a list of scores
            # and the second element is the path to the pose file
            if pose_data and isinstance(pose_data[0], list) and pose_data[0]:
                score = pose_data[0][0]  # Get the first score from the first list
                if score < best_score:
                    best_score = score
                    best_pose = pose_name
        
        if best_pose:
            return best_score, best_pose.replace('.pdbqt', '')
        else:
            return None, None
    
    except Exception as e:
        # Try to extract the best score directly from the string if parsing failed
        try:
            if isinstance(pose_pred_str, str):
                # Look for patterns like [[-6.2, ...]] to extract the best score
                import re
                score_match = re.search(r'\[\[([-\d\.]+)', pose_pred_str)
                if score_match:
                    return float(score_match.group(1)), "unknown_pose"
        except:
            pass
        
        logger.warning(f"Error extracting pose data: {e}")
        return None, None

# Helper function to run retrosynthesis with timeout
def run_retrosynthesis_with_timeout(smiles, output_path, timeout=300):
    """
    Run retrosynthesis with a timeout using multiprocessing.
    
    Args:
        smiles: SMILES string of the compound
        output_path: Path to save the output CSV
        timeout: Maximum time in seconds to wait (default: 300 seconds / 5 minutes)
        
    Returns:
        True if successful, False if failed or timed out
    """
    def worker(smiles, output_path, queue):
        result = run_retrosynthesis(smiles, output_path)
        queue.put(result)
    
    # Create a queue to get the result
    queue = Queue()
    
    # Create and start the process
    process = Process(target=worker, args=(smiles, output_path, queue))
    process.start()
    
    # Wait for the specified timeout
    process.join(timeout)
    
    # If the process is still running after the timeout
    if process.is_alive():
        logger.warning(f"Retrosynthesis timed out after {timeout} seconds for SMILES: {smiles}")
        # Terminate the process
        process.terminate()
        process.join()
        return False
    
    # If the process finished within the timeout, get the result
    if not queue.empty():
        return queue.get()
    
    return False

def update_tracking_report(report_file, new_data, report_type="compound"):
    """
    Incrementally update the tracking report with new data.
    
    Args:
        report_file: Path to the report CSV file
        new_data: Dictionary containing the new data to add
        report_type: Type of data being added ("compound", "variant", or "docking")
    """
    try:
        # Create base columns for the report
        base_columns = [
            'compound_id', 'barcode', 'generation', 'round', 'smiles',
            'parent_id', 'status', 'source', 'timestamp'
        ]
        
        # Add type-specific columns
        if report_type == "variant":
            base_columns.extend(['source_compound', 'parent_barcode', 'score'])
        elif report_type == "docking":
            base_columns.extend(['docking_score', 'best_pose'])
        
        # Add timestamp to the new data
        new_data['timestamp'] = datetime.now().isoformat()
        
        # Create or load existing report
        if report_file.exists():
            df = pd.read_csv(report_file)
            # Add any new columns that might be in the new data
            for col in new_data.keys():
                if col not in df.columns:
                    df[col] = None
        else:
            df = pd.DataFrame(columns=base_columns)
        
        # Convert new data to DataFrame row
        new_row = pd.DataFrame([new_data])
        
        # Append new data
        df = pd.concat([df, new_row], ignore_index=True)
        
        # Save updated report
        df.to_csv(report_file, index=False)
        logger.debug(f"Updated tracking report with new {report_type} data")
        
    except Exception as e:
        logger.error(f"Error updating tracking report: {e}")

def setup_logging(out_dir: Path) -> None:
    """
    Set up logging with both console and file output in the specified directory.
    
    Args:
        out_dir: Output directory path where logs will be stored
    """
    # Create logs directory
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    
    # Configure the root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    
    # Create handlers
    console_handler = logging.StreamHandler(sys.stdout)
    file_handler = ThreadSafeRotatingFileHandler(
        str(logs_dir / "quick_pipeline.log"),
        mode="w"
    )
    
    # Set formatter
    formatter = logging.Formatter("[%(asctime)s] %(name)s - %(levelname)s - %(message)s")
    console_handler.setFormatter(formatter)
    file_handler.setFormatter(formatter)
    
    # Remove any existing handlers from both root and module logger
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
    
    # Add handlers to root logger
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)
    
    # Start logging
    logger.info("Starting quick pipeline...")
    logger.info(f"Logs will be saved to: {logs_dir}")

def main(out_dir, checkpoint, pdbfile, resi_list, n_samples, sanitize,
         receptor, program_choice="qvina", scoring_function="nnscore2",
         center=(114.817, 75.602, 82.416), box_size=(38, 70, 58),
         exhaustiveness=10, is_selfies=False, is_peptide=False, 
         top_n=5, max_variants=5, num_rounds=1, stop_flag=None):
    """
    Multi-round quick pipeline main function with batch filtering optimization.
    
    Args:
        stop_flag: Dictionary containing status information for stopping the pipeline
    """
    # Set up output directories
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    
    # Set up logging first
    setup_logging(out_dir)
    
    # Create tracking report files
    master_dir = out_dir / "master_tracking"
    master_dir.mkdir(exist_ok=True)
    master_report = master_dir / "master_compound_tracking_report.csv"
    
    # Loop through each round
    for round_num in range(1, num_rounds + 1):
        # Check if pipeline should stop
        if stop_flag and not stop_flag.get("running", True):
            logger.info("Pipeline stop requested. Stopping gracefully...")
            break
            
        logger.info(f"============= STARTING ROUND {round_num}/{num_rounds} =============")
        
        # Create round-specific directories
        round_dir = out_dir / f"round_{round_num}"
        round_dir.mkdir(exist_ok=True)
        round_report = round_dir / f"round_{round_num}_tracking_report.csv"
        
        ligand_gen_dir = round_dir / "ligand_generation"
        retro_dir = round_dir / "retrosyn_results"
        dock_dir = round_dir / "docking_results"
        filter_dir = round_dir / "filter_results"
        
        for dir_path in [ligand_gen_dir, retro_dir, dock_dir, filter_dir]:
            dir_path.mkdir(exist_ok=True)
        
        # Step 1: Ligand Generation
        logger.info(f"Round {round_num}: Running ligand generation...")
        base_name = f"round_{round_num}"
        ligand_gen_out = ligand_gen_dir / f"{base_name}_mols_gen.sdf"
        
        # Check stop flag before starting ligand generation
        if stop_flag and not stop_flag.get("running", True):
            break
            
        lg_thread = run_ligand_generation(
            checkpoint=checkpoint,
            pdbfile=pdbfile,
            outfile=str(ligand_gen_out),
            resi_list=resi_list.split(),
            n_samples=n_samples,
            sanitize=sanitize,
            log_callback=logger.info
        )
        lg_thread.join()
        
        # Check stop flag after ligand generation
        if stop_flag and not stop_flag.get("running", True):
            break
            
        # Step 2: Process compounds
        compounds = extract_smiles_from_sdf(ligand_gen_out)
        if not compounds:
            logger.error(f"Round {round_num}: No valid compounds generated. Skipping this round.")
            continue
            
        # Collect all variants for batch processing
        all_variants = []
        total_compounds = len(compounds)
        
        # Step 3: Sequential retrosynthesis (VRAM intensive)
        for idx, compound in enumerate(compounds, 1):
            # Check stop flag before each compound
            if stop_flag and not stop_flag.get("running", True):
                break
                
            # Add tracking information
            barcode = f"R{round_num}-GEN-{idx:04d}"
            compound.update({
                "barcode": barcode,
                "generation": str(round_num),
                "round": round_num,
                "status": "GENERATED",
                "source": "AI_GENERATION",
                "parent_id": "NONE"
            })
            
            # Update tracking reports
            update_tracking_report(round_report, compound, "compound")
            update_tracking_report(master_report, compound, "compound")
            
            # Run retrosynthesis
            cid = compound["compound_id"]
            smiles = compound["smiles"]
            logger.info(f"Round {round_num}: Running retrosynthesis {idx}/{total_compounds}: {cid}")
            
            retro_output = retro_dir / f"{cid}_retrosyn.csv"
            success = run_retrosynthesis_with_timeout(smiles, retro_output, timeout=300)
            
            if success:
                variants = extract_variants_from_retrosynthesis(retro_output, max_variants=max_variants)
                
                # Add metadata to variants
                for vidx, variant in enumerate(variants):
                    variant_barcode = f"R{round_num}-{barcode}-V-{vidx+1:02d}"
                    variant.update({
                        "source_compound": cid,
                        "source_smiles": smiles,
                        "barcode": variant_barcode,
                        "generation": str(round_num + 1),
                        "round": round_num,
                        "status": "SYNTHETIZED",
                        "source": "RETROSYNTHESIS"
                    })
                    all_variants.append(variant)
                    
                    # Update tracking for variant generation
                    update_tracking_report(round_report, variant, "variant")
                    update_tracking_report(master_report, variant, "variant")
        
        # Check stop flag before batch filtering
        if stop_flag and not stop_flag.get("running", True):
            break
            
        # Step 4: Batch filtering of all variants
        logger.info(f"Round {round_num}: Starting batch filtering of {len(all_variants)} variants")
        filtered_variants = apply_medchem_filtering_to_variants(all_variants, filter_dir)
        
        if not filtered_variants:
            logger.warning(f"Round {round_num}: No variants passed MedChem filtering. Skipping this round.")
            continue
            
        logger.info(f"Round {round_num}: After MedChem filtering, {len(filtered_variants)} variants remain")
        
        # Save filtered variants to SDF for reference
        filtered_sdf = filter_dir / f"round_{round_num}_filtered_variants.sdf"
        smiles_to_sdf(filtered_variants, filtered_sdf)
        
        # Update tracking for filtered variants
        for variant in filtered_variants:
            variant["status"] = "PASSFILTER"
            update_tracking_report(round_report, variant, "variant")
            update_tracking_report(master_report, variant, "variant")
        
        # Check stop flag before docking
        if stop_flag and not stop_flag.get("running", True):
            break
            
        # Step 5: Sequential docking (CPU intensive)
        logger.info(f"Round {round_num}: Starting docking of {len(filtered_variants)} filtered variants")
        
        # Prepare docking parameters
        center_x, center_y, center_z = center
        size_x, size_y, size_z = box_size
        redock_params = (
            program_choice, scoring_function,
            center_x, center_y, center_z,
            size_x, size_y, size_z,
            exhaustiveness, is_selfies, is_peptide
        )
        
        # Create a directory for each variant's docking results
        round_redock_results = []
        for idx, variant in enumerate(filtered_variants, 1):
            # Check stop flag before each docking
            if stop_flag and not stop_flag.get("running", True):
                break
                
            variant_id = variant["variant_id"]
            smiles = variant["smiles"]
            barcode = variant["barcode"]
            
            logger.info(f"Round {round_num}: Docking variant {idx}/{len(filtered_variants)}: {variant_id}")
            
            # Run docking
            pose_out, rescored = redock_compound(
                variant_id,
                smiles,
                redock_params,
                receptor=receptor,
                log_callback=logger.info
            )
            
            if pose_out:
                # Extract docking information
                best_score, best_pose = extract_best_pose_and_score(pose_out)
                
                # Update variant with docking results
                variant.update({
                    "status": "DOCKED",
                    "docking_score": best_score,
                    "best_pose": best_pose,
                    "pose_pred_out": pose_out,
                    "re_scored_values": rescored
                })
                
                round_redock_results.append(variant)
                
                # Update tracking with docking results
                update_tracking_report(round_report, variant, "docking")
                update_tracking_report(master_report, variant, "docking")
                
                # Save docking outputs
                variant_poses_dir = dock_dir / f"variant_{barcode}"
                variant_poses_dir.mkdir(exist_ok=True)
                vfu_outputs_dir = Path(vfu_dir) / "outputs"
                
                for file_path in vfu_outputs_dir.glob("*"):
                    if file_path.is_file():
                        shutil.copy2(file_path, variant_poses_dir)
                    elif file_path.is_dir():
                        dest_dir = variant_poses_dir / file_path.name
                        if dest_dir.exists():
                            shutil.rmtree(dest_dir)
                        shutil.copytree(file_path, dest_dir)
        
        logger.info(f"Round {round_num}: Successfully docked {len(round_redock_results)} variants")
        logger.info(f"============= COMPLETED ROUND {round_num}/{num_rounds} =============")
    
    if stop_flag and not stop_flag.get("running", True):
        logger.info("Pipeline stopped by user request")
    else:
        logger.info(f"Multi-round quick pipeline completed successfully. Total rounds: {num_rounds}")

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Quick pipeline for drug discovery")
    
    # Required parameters
    parser.add_argument("--out_dir", type=str, help="Output directory", required=True)

    parser.add_argument("--checkpoint", type=str, default="src/DiffSBDD/checkpoints/crossdocked_fullatom_cond.ckpt",
                        help="Path to the checkpoint file (default: src/DiffSBDD/checkpoints/crossdocked_fullatom_cond.ckpt)")
    
    parser.add_argument("--pdbfile", type=str, default="input/NS5.pdb",
                        help="Path to target protein PDB file")
    
    parser.add_argument("--resi_list", type=str, default="A:719 A:770 A:841 A:856 A:887 A:888",
                        help="Residue identifiers (space-separated)")
    
    parser.add_argument("--receptor", required=False, help="Receptor file for docking", default="NS5_test.pdbqt")
    
    # Optional parameters with defaults
    parser.add_argument("--n_samples", type=int, default=200, help="Number of samples to generate")
    parser.add_argument("--sanitize", action="store_true", help="Sanitize generated molecules", default=True)
    parser.add_argument("--program_choice", default="qvina", help="Docking program choice")
    parser.add_argument("--scoring_function", default="nnscore2", help="Scoring function")
    parser.add_argument("--center", nargs=3, type=float, default=[114.817, 75.602, 82.416], 
                        help="Docking box center coordinates")
    parser.add_argument("--box_size", nargs=3, type=int, default=[38, 70, 58],
                        help="Docking box dimensions")
    parser.add_argument("--exhaustiveness", type=int, default=32, help="Docking exhaustiveness")
    parser.add_argument("--is_selfies", action="store_true", help="Use SELFIES representation", default=False)
    parser.add_argument("--is_peptide", action="store_true", help="Ligand is a peptide", default=False)
    parser.add_argument("--top_n", type=int, default=5, 
                        help="Number of top compounds to process")
    parser.add_argument("--max_variants", type=int, default=5,
                        help="Maximum number of variants per compound")
    parser.add_argument("--num_rounds", type=int, default=1,
                        help="Number of rounds to run the pipeline")
    
    args = parser.parse_args()
    
    main(
        args.out_dir,
        args.checkpoint,
        args.pdbfile,
        args.resi_list,
        args.n_samples,
        args.sanitize,
        args.receptor,
        args.program_choice,
        args.scoring_function,
        args.center,
        args.box_size,
        args.exhaustiveness,
        args.is_selfies,
        args.is_peptide,
        args.top_n,
        args.max_variants,
        args.num_rounds
    )