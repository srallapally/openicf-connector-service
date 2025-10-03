import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { z } from "zod";
import type { RequestHandler } from "express";

export const securityMiddleware: RequestHandler[] = [
  helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }),
  cors({ origin: false }),
  rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }),
];

import express from "express";

export const bodyLimit = (size = "512kb") => [ express.json({ limit: size }) ];

export const requestTimeout: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Request-Timeout", "30000");
  next();
};

export function sanitize(obj: unknown): unknown {
  if (obj && typeof obj === "object") {
    const clone: any = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj as any)) {
      clone[k] = /pass|secret|token|key/i.test(k) ? "***" : sanitize(v as any);
    }
    return clone;
  }
  return obj;
}

const primitive = z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]);
const boundedArray = <T extends z.ZodTypeAny>(t: T) => z.array(t).max(500);
const boundedObject = (lazySelf: () => z.ZodTypeAny) =>
  z.record(
    z.string().min(1).max(128),
    z.union([primitive, boundedArray(primitive), z.lazy(lazySelf), boundedArray(z.lazy(lazySelf))])
  ).refine(obj => Object.keys(obj).length <= 100, { message: "Too many keys" });

export const attributeValueSchema: z.ZodType<any> = z.lazy(() =>
  z.union([primitive, boundedArray(primitive), boundedObject(() => attributeValueSchema), boundedArray(boundedObject(() => attributeValueSchema))])
);

export const attributesRecordSchema = z.record(attributeValueSchema);

const sortKeySchema = z.object({ field: z.string().min(1).max(128), ascending: z.boolean().optional() });
const optionsBase = {
  attributesToGet: z.array(z.string().min(1).max(256)).max(200).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  pagedResultsOffset: z.number().int().min(0).max(1_000_000).optional(),
  pagedResultsCookie: z.string().max(10000).nullable().optional(),
  sortKeys: z.array(sortKeySchema).max(5).optional(),
  container: z.object({ objectClass: z.string().min(1).max(128), uid: z.string().min(1).max(512) }).nullable().optional(),
  scope: z.enum(["OBJECT","ONE_LEVEL","SUBTREE"]).optional(),
  totalPagedResultsPolicy: z.enum(["NONE","ESTIMATE","EXACT"]).optional(),
  runAsUser: z.string().max(512).nullable().optional(),
  runWithPassword: z.string().max(10000).nullable().optional(),
  requireSerial: z.boolean().optional(),
  failOnError: z.boolean().optional(),
  sortBy: z.string().min(1).max(128).optional(),
  sortOrder: z.enum(["ASC","DESC"]).optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
};

export const createPayloadSchema = z.object({ attrs: attributesRecordSchema, options: z.object(optionsBase).optional() });
export const updatePayloadSchema = createPayloadSchema;
export const searchPayloadSchema = z.object({ filter: z.any(), options: z.object(optionsBase).optional() });
