import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // Training runs
  runs: defineTable({
    name: v.string(),
    engine: v.union(v.literal('boltz'), v.literal('flashbind')),
    status: v.union(
      v.literal('idle'),
      v.literal('running'),
      v.literal('paused'),
      v.literal('completed'),
      v.literal('error')
    ),
    currentStep: v.number(),
    totalSteps: v.number(),
    resultDir: v.string(),
    checkpointPath: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
    startedAt: v.union(v.number(), v.null()),
    completedAt: v.union(v.number(), v.null()),
    lastUpdatedAt: v.number(),
  }).index('by_status', ['status']),

  // Uploaded files (PDB, YAML, etc.)
  files: defineTable({
    name: v.string(),
    type: v.union(v.literal('pdb'), v.literal('yaml'), v.literal('msa'), v.literal('db'), v.literal('other')),
    // Field type identifies which config field this file is used for
    fieldType: v.union(
      v.literal('protein_pdb'),
      v.literal('boltz_yaml'),
      v.literal('msa'),
      v.literal('other')
    ),
    storageId: v.id('_storage'),
    size: v.number(),
    runId: v.union(v.id('runs'), v.null()),
    createdAt: v.number(),
  })
    .index('by_run', ['runId'])
    .index('by_type', ['type'])
    .index('by_field_type', ['fieldType']),

  // Generated molecules (synced from SQLite)
  molecules: defineTable({
    runId: v.id('runs'),
    // Optional for legacy rows synced before engine was tracked; backfill via molecules.backfillMissingEngine.
    engine: v.optional(v.union(v.literal('boltz'), v.literal('flashbind'))),
    smiles: v.string(),
    reward: v.number(),
    normalizedAffinity: v.optional(v.union(v.number(), v.null())),
    normalizedProbability: v.optional(v.union(v.number(), v.null())),
    normalizedScore: v.optional(v.union(v.number(), v.null())),
    trajectory: v.string(), // JSON string
    // Boltz scores
    affinityEnsemble: v.union(v.number(), v.null()),
    probabilityEnsemble: v.union(v.number(), v.null()),
    affinityModel1: v.union(v.number(), v.null()),
    probabilityModel1: v.union(v.number(), v.null()),
    affinityModel2: v.union(v.number(), v.null()),
    probabilityModel2: v.union(v.number(), v.null()),
    oracleIdx: v.union(v.number(), v.null()),
    molIdx: v.union(v.number(), v.null()),
    // Complex file reference
    complexFileId: v.union(v.id('files'), v.null()),
    iteration: v.number(),
    createdAt: v.number(),
  })
    .index('by_run', ['runId'])
    .index('by_run_reward', ['runId', 'reward'])
    .index('by_smiles', ['smiles']),

  // User annotations on molecules
  annotations: defineTable({
    moleculeId: v.id('molecules'),
    note: v.string(),
    starred: v.boolean(),
    tags: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_molecule', ['moleculeId']),
});
