import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';

const moleculeValidator = v.object({
  _id: v.id('molecules'),
  _creationTime: v.number(),
  runId: v.id('runs'),
  engine: v.optional(v.union(v.literal('boltz'), v.literal('flashbind'))),
  smiles: v.string(),
  reward: v.number(),
  normalizedAffinity: v.optional(v.union(v.number(), v.null())),
  normalizedProbability: v.optional(v.union(v.number(), v.null())),
  normalizedScore: v.optional(v.union(v.number(), v.null())),
  trajectory: v.string(),
  affinityEnsemble: v.union(v.number(), v.null()),
  probabilityEnsemble: v.union(v.number(), v.null()),
  affinityModel1: v.union(v.number(), v.null()),
  probabilityModel1: v.union(v.number(), v.null()),
  affinityModel2: v.union(v.number(), v.null()),
  probabilityModel2: v.union(v.number(), v.null()),
  oracleIdx: v.union(v.number(), v.null()),
  molIdx: v.union(v.number(), v.null()),
  complexFileId: v.union(v.id('files'), v.null()),
  iteration: v.number(),
  createdAt: v.number(),
});

export const upsert = mutation({
  args: {
    runId: v.id('runs'),
    engine: v.union(v.literal('boltz'), v.literal('flashbind')),
    smiles: v.string(),
    reward: v.number(),
    normalizedAffinity: v.union(v.number(), v.null()),
    normalizedProbability: v.union(v.number(), v.null()),
    normalizedScore: v.union(v.number(), v.null()),
    trajectory: v.string(),
    affinityEnsemble: v.union(v.number(), v.null()),
    probabilityEnsemble: v.union(v.number(), v.null()),
    affinityModel1: v.union(v.number(), v.null()),
    probabilityModel1: v.union(v.number(), v.null()),
    affinityModel2: v.union(v.number(), v.null()),
    probabilityModel2: v.union(v.number(), v.null()),
    oracleIdx: v.union(v.number(), v.null()),
    molIdx: v.union(v.number(), v.null()),
    complexFileId: v.union(v.id('files'), v.null()),
    iteration: v.number(),
  },
  returns: v.id('molecules'),
  handler: async (ctx, args) => {
    // Check if molecule already exists for this run
    const existing = await ctx.db
      .query('molecules')
      .withIndex('by_smiles', (q) => q.eq('smiles', args.smiles))
      .filter((q) => q.eq(q.field('runId'), args.runId))
      .first();

    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        engine: args.engine,
        reward: args.reward,
        normalizedAffinity: args.normalizedAffinity,
        normalizedProbability: args.normalizedProbability,
        normalizedScore: args.normalizedScore,
        trajectory: args.trajectory,
        affinityEnsemble: args.affinityEnsemble,
        probabilityEnsemble: args.probabilityEnsemble,
        affinityModel1: args.affinityModel1,
        probabilityModel1: args.probabilityModel1,
        affinityModel2: args.affinityModel2,
        probabilityModel2: args.probabilityModel2,
        oracleIdx: args.oracleIdx,
        molIdx: args.molIdx,
        complexFileId: args.complexFileId,
        iteration: args.iteration,
      });
      return existing._id;
    }

    // Create new
    return await ctx.db.insert('molecules', {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const batchUpsert = mutation({
  args: {
    molecules: v.array(
      v.object({
        runId: v.id('runs'),
        engine: v.union(v.literal('boltz'), v.literal('flashbind')),
        smiles: v.string(),
        reward: v.number(),
        normalizedAffinity: v.union(v.number(), v.null()),
        normalizedProbability: v.union(v.number(), v.null()),
        normalizedScore: v.union(v.number(), v.null()),
        trajectory: v.string(),
        affinityEnsemble: v.union(v.number(), v.null()),
        probabilityEnsemble: v.union(v.number(), v.null()),
        affinityModel1: v.union(v.number(), v.null()),
        probabilityModel1: v.union(v.number(), v.null()),
        affinityModel2: v.union(v.number(), v.null()),
        probabilityModel2: v.union(v.number(), v.null()),
        oracleIdx: v.union(v.number(), v.null()),
        molIdx: v.union(v.number(), v.null()),
        complexFileId: v.union(v.id('files'), v.null()),
        iteration: v.number(),
      })
    ),
  },
  returns: v.array(v.id('molecules')),
  handler: async (ctx, args) => {
    const results: Id<'molecules'>[] = [];
    
    for (const mol of args.molecules) {
      const existing = await ctx.db
        .query('molecules')
        .withIndex('by_smiles', (q) => q.eq('smiles', mol.smiles))
        .filter((q) => q.eq(q.field('runId'), mol.runId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          engine: mol.engine,
          reward: mol.reward,
          normalizedAffinity: mol.normalizedAffinity,
          normalizedProbability: mol.normalizedProbability,
          normalizedScore: mol.normalizedScore,
          trajectory: mol.trajectory,
          affinityEnsemble: mol.affinityEnsemble,
          probabilityEnsemble: mol.probabilityEnsemble,
          affinityModel1: mol.affinityModel1,
          probabilityModel1: mol.probabilityModel1,
          affinityModel2: mol.affinityModel2,
          probabilityModel2: mol.probabilityModel2,
          oracleIdx: mol.oracleIdx,
          molIdx: mol.molIdx,
          complexFileId: mol.complexFileId,
          iteration: mol.iteration,
        });
        results.push(existing._id);
      } else {
        const id = await ctx.db.insert('molecules', {
          ...mol,
          createdAt: Date.now(),
        });
        results.push(id);
      }
    }

    return results;
  },
});

export const getByRun = query({
  args: {
    runId: v.id('runs'),
    limit: v.optional(v.number()),
    orderBy: v.optional(v.union(v.literal('reward'), v.literal('iteration'))),
  },
  returns: v.array(moleculeValidator),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query('molecules')
      .withIndex('by_run', (q) => q.eq('runId', args.runId));

    const molecules = await query.collect();

    // Sort by reward (descending) or iteration
    if (args.orderBy === 'iteration') {
      molecules.sort((a, b) => b.iteration - a.iteration);
    } else {
      molecules.sort((a, b) => b.reward - a.reward);
    }

    // Apply limit
    if (args.limit) {
      return molecules.slice(0, args.limit);
    }

    return molecules;
  },
});

export const getTopByRun = query({
  args: {
    runId: v.id('runs'),
    limit: v.number(),
  },
  returns: v.array(moleculeValidator),
  handler: async (ctx, args) => {
    const molecules = await ctx.db
      .query('molecules')
      .withIndex('by_run_reward', (q) => q.eq('runId', args.runId))
      .order('desc')
      .take(args.limit);

    return molecules;
  },
});

export const get = query({
  args: { id: v.id('molecules') },
  returns: v.union(moleculeValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const backfillMissingEngine = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const molecules = await ctx.db.query('molecules').collect();
    let patched = 0;

    for (const mol of molecules) {
      const needsEngine = mol.engine === undefined;
      const needsNormalized =
        mol.normalizedAffinity === undefined ||
        mol.normalizedProbability === undefined ||
        mol.normalizedScore === undefined;

      if (!needsEngine && !needsNormalized) {
        continue;
      }

      const run = await ctx.db.get(mol.runId);
      const patch: {
        engine?: 'boltz' | 'flashbind';
        normalizedAffinity?: number | null;
        normalizedProbability?: number | null;
        normalizedScore?: number | null;
      } = {};

      if (needsEngine) {
        patch.engine = run?.engine ?? 'boltz';
      }
      if (mol.normalizedAffinity === undefined) {
        patch.normalizedAffinity = null;
      }
      if (mol.normalizedProbability === undefined) {
        patch.normalizedProbability = null;
      }
      if (mol.normalizedScore === undefined) {
        patch.normalizedScore = null;
      }

      await ctx.db.patch(mol._id, patch);
      patched += 1;
    }

    return patched;
  },
});

export const remove = mutation({
  args: { id: v.id('molecules') },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Delete associated annotations
    const annotations = await ctx.db
      .query('annotations')
      .withIndex('by_molecule', (q) => q.eq('moleculeId', args.id))
      .collect();

    for (const ann of annotations) {
      await ctx.db.delete(ann._id);
    }

    await ctx.db.delete(args.id);
    return null;
  },
});