import { z } from "zod";
import type { Node } from "./ast.js";

const PathSchema = z.array(z.string().min(1).max(128)).min(1).max(8);

const CmpSchema = z.object({
  type: z.literal("CMP"),
  op: z.enum(["EQ","CONTAINS","STARTS_WITH","ENDS_WITH","GT","GTE","LT","LTE","IN","EXISTS"]),
  path: PathSchema,
  // ⬇️ put .min/.max on the array, not the union
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])).min(1).max(100)
  ]).optional()
}).refine(
    v => (v.op === "EXISTS") === (v.value === undefined),
    { message: "EXISTS must not have a value; others must have a value" }
);
const NodeSchema: z.ZodType<Node> = z.lazy(() => z.union([
  CmpSchema,
  z.object({ type: z.literal("AND"), nodes: z.array(NodeSchema).min(1).max(50) }),
  z.object({ type: z.literal("OR"),  nodes: z.array(NodeSchema).min(1).max(50) }),
  z.object({ type: z.literal("NOT"), node: NodeSchema }),
]));

export function parseFilter(input: unknown): Node {
  return NodeSchema.parse(input);
}
