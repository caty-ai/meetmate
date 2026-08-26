"use strict";

const { z } = require("zod");
const { MASK, SETTINGS_REGISTRY } = require("./registry");

const sha256RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.union([sha256RevisionSchema, z.literal("bootstrap")]);

const mutationShape = {};
for (const entry of SETTINGS_REGISTRY.filter((item) => item.writeSurface === "settings")) {
  mutationShape[entry.id] = entry.credential === "class-1"
    ? z.union([z.literal(MASK), entry.schema, z.null()]).optional()
    : entry.schema.optional();
}

const settingsMutationSchema = z.object({
  schemaVersion: z.literal(1),
  revision: revisionSchema,
  fields: z.object(mutationShape).strict(),
}).strict();

const revisionOnlySchema = z.object({ revision: revisionSchema }).strict();
const sha256RevisionOnlySchema = z.object({ revision: sha256RevisionSchema }).strict();

const importableShape = {};
for (const entry of SETTINGS_REGISTRY.filter((item) => item.writeSurface === "settings" && item.credential === "none")) {
  importableShape[entry.id] = entry.schema.optional();
}

const exportSettingsSchema = z.object(importableShape).strict();
const exportDocumentSchema = z.object({
  format: z.literal("meetmate-settings"),
  version: z.literal(1),
  exportedAt: z.string().datetime({ offset: false }),
  settings: exportSettingsSchema,
}).strict();

const importRequestSchema = z.object({
  revision: sha256RevisionSchema,
  document: exportDocumentSchema,
}).strict();

function findPrototypeKey(value, currentPath = []) {
  if (!value || typeof value !== "object") return null;
  for (const key of Object.keys(value)) {
    const nextPath = [...currentPath, key];
    if (key === "__proto__" || key === "prototype" || key === "constructor") return nextPath.join(".");
    const child = findPrototypeKey(value[key], nextPath);
    if (child) return child;
  }
  return null;
}

function assertNoPrototypeKeys(value) {
  const badPath = findPrototypeKey(value);
  if (!badPath) return;
  const error = new Error("Request validation failed");
  error.code = "SETTINGS_VALIDATION_FAILED";
  error.details = [{ path: badPath, code: "prototype_key" }];
  throw error;
}

function parseStrict(schema, value) {
  assertNoPrototypeKeys(value);
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error("Request validation failed");
  error.code = "SETTINGS_VALIDATION_FAILED";
  error.details = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }));
  throw error;
}

module.exports = {
  parseStrict,
  exportDocumentSchema,
  exportSettingsSchema,
  importRequestSchema,
  revisionOnlySchema,
  revisionSchema,
  settingsMutationSchema,
  sha256RevisionOnlySchema,
  sha256RevisionSchema,
};
