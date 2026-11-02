import { z } from "zod";

export const collectionModeSchema = z.enum(["fast", "full"]);

export const createCollectionJobSchema = z
  .object({
    mode: collectionModeSchema.default("fast"),
  })
  .strict();

export type CollectionMode = z.infer<typeof collectionModeSchema>;
