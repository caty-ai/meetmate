"use strict";

const { z } = require("zod");
const { MASK, SETTINGS_REGISTRY } = require("./registry");

const SERVER_OWNED_HOSTED_IDENTITY_IDS = new Set([
  "hub_installation_id",
  "hub_cloud_hub_url",
  "hub_plan_id",
  "hub_expires_at",
  "hub_config_refreshed_at",
]);

function isImportableSetting(entry) {
  return entry.writeSurface === "settings"
    && entry.credential === "none"
    && !SERVER_OWNED_HOSTED_IDENTITY_IDS.has(entry.id);
}

const sha256RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.union([sha256RevisionSchema, z.literal("bootstrap")]);
const floorSettingsSchema = z.object({
  url: z.string().refine((value) => {
    if (value === "") return true;
    try {
      const parsed = new URL(value);
      return ["ws:", "wss:"].includes(parsed.protocol)
        && !parsed.username && !parsed.password && !parsed.hash;
    } catch {
      return false;
    }
  }, "HUB_URL must be an absolute ws:// or wss:// URL"),
  roomCode: z.string().trim().max(256),
  sharedToken: z.string().max(4096),
  token: z.string().max(4096),
  cloudHubUrl: z.string().refine((value) => {
    if (value === "") return true;
    try {
      const parsed = new URL(value);
      return ["ws:", "wss:"].includes(parsed.protocol)
        && !parsed.username && !parsed.password && !parsed.hash;
    } catch {
      return false;
    }
  }, "Cloud hub URL must be an absolute ws:// or wss:// URL"),
  cloudUrl: z.string().refine((value) => {
    if (value === "") return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
    } catch {
      return false;
    }
  }, "CATY_CLOUD_URL must be an absolute https:// URL"),
  roomSalt: z.string().max(4096),
  roomSaltVersion: z.string().max(128),
  installationId: z.string().max(256),
  planId: z.string().max(128),
  tailMs: z.number().int().min(0).max(5000),
  debug: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.token && !value.cloudHubUrl) {
    context.addIssue({ code: "custom", message: "hub.cloudHubUrl and HUB_TOKEN must be set together" });
  } else if (!value.token && Boolean(value.url) !== Boolean(value.roomCode)) {
    context.addIssue({ code: "custom", message: "HUB_URL and HUB_ROOM_CODE must be set together" });
  }
});

function parseFloorSettings(value) {
  const parsed = floorSettingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(parsed.error.issues[0]?.message || "Invalid floor hub settings");
}

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
const cloudConnectRequestSchema = z.object({
  revision: revisionSchema,
  cloudUrl: z.string().trim().min(1).max(2048).optional(),
}).strict();
const cloudDisconnectRequestSchema = z.object({
  revision: revisionSchema,
  force: z.boolean().optional(),
}).strict();
const ttsPreviewSchema = z.object({
  revision: sha256RevisionSchema,
  text: z.string().trim().min(1).refine((value) => [...value].length <= 500, "too_big"),
}).strict();
const audioMetadataSchema = z.object({
  role: z.enum(["ack", "progress", "greeting", "farewell", "timeout"]),
  text: z.string().trim().min(1).refine((value) => [...value].length <= 4096, "too_big"),
  revision: sha256RevisionSchema,
}).strict();

const importableShape = {};
for (const entry of SETTINGS_REGISTRY.filter(isImportableSetting)) {
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
  audioMetadataSchema,
  cloudConnectRequestSchema,
  cloudDisconnectRequestSchema,
  floorSettingsSchema,
  isImportableSetting,
  parseFloorSettings,
  parseStrict,
  exportDocumentSchema,
  exportSettingsSchema,
  importRequestSchema,
  revisionOnlySchema,
  revisionSchema,
  settingsMutationSchema,
  sha256RevisionOnlySchema,
  sha256RevisionSchema,
  ttsPreviewSchema,
};
