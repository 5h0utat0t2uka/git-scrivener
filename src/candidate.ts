import { z } from "zod";

export const CommitCandidate = z.strictObject({
  type: z.string(),
  scope: z.string().nullable(),
  description: z.string(),
  body: z.string().nullable(),
  breaking: z.boolean(),
  breakingDescription: z.string().nullable(),
  footers: z.array(
    z.strictObject({
      token: z.string(),
      separator: z.enum([":", "#"]),
      value: z.string(),
    }),
  ),
});

export type CommitCandidate = z.infer<typeof CommitCandidate>;
