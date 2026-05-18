import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const MODEL_CONFIG_FILE = path.join(DATA_DIR, "model-config.json");

export type ModelProfile = {
  id: string;
  name: string;
  authToken: string;
  baseURL: string;
  model: string;
};

export type RuntimeModelWorkspaceConfig = {
  activeProfileId: string;
  profiles: ModelProfile[];
};

function validateProfile(profile: ModelProfile) {
  if (!profile.name.trim()) {
    throw new Error("模型 tab 名称不能为空。");
  }

  if (!profile.authToken.trim()) {
    throw new Error(`模型「${profile.name}」缺少 OPENAI_API_KEY。`);
  }

  if (!profile.baseURL.trim()) {
    throw new Error(`模型「${profile.name}」缺少 OPENAI_BASE_URL。`);
  }

  if (!profile.model.trim()) {
    throw new Error(`模型「${profile.name}」缺少 OPENAI_MODEL。`);
  }

  if (/\/anthropic\/?$/i.test(profile.baseURL.trim())) {
    throw new Error(
      `模型「${profile.name}」当前配置的是 Anthropic 兼容端点（${profile.baseURL}），但本项目使用 OpenAI-compatible 调用。请改成对应的 OpenAI 兼容地址。`,
    );
  }
}

export function getProfileValidationError(profile: ModelProfile) {
  try {
    validateProfile(profile);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "模型配置错误。";
  }
}

type LegacyModelConfig = {
  authToken?: string;
  baseURL?: string;
  selectedModel?: string;
  availableModels?: string[];
};

function sanitizeProfileId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function makeProfileId(name: string, fallback = "model") {
  const normalized = sanitizeProfileId(name.trim().toLowerCase());
  return normalized || `${fallback}-${Date.now()}`;
}

function getDefaultProfile(): ModelProfile {
  const model =
    process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || "mimo-v2.5-pro";

  return {
    id: makeProfileId(model, "default"),
    name: model,
    authToken:
      process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
    baseURL:
      process.env.OPENAI_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      "https://token-plan-sgp.xiaomimimo.com/v1",
    model,
  };
}

function normalizeProfile(
  input: Partial<ModelProfile> | null | undefined,
  fallback: ModelProfile,
) {
  const name = input?.name?.trim() || input?.model?.trim() || fallback.name;
  const model = input?.model?.trim() || fallback.model;

  return {
    id: input?.id?.trim() || fallback.id || makeProfileId(name),
    name,
    authToken: input?.authToken?.trim() || fallback.authToken,
    baseURL: input?.baseURL?.trim() || fallback.baseURL,
    model,
  } satisfies ModelProfile;
}

function dedupeProfiles(profiles: ModelProfile[]) {
  const seen = new Set<string>();
  const result: ModelProfile[] = [];

  for (const profile of profiles) {
    if (!profile.id || seen.has(profile.id)) {
      continue;
    }

    seen.add(profile.id);
    result.push(profile);
  }

  return result;
}

function migrateLegacyConfig(legacy: LegacyModelConfig) {
  const fallback = getDefaultProfile();
  const modelNames = Array.from(
    new Set(
      [...(legacy.availableModels || []), legacy.selectedModel || fallback.model]
        .map((item) => item?.trim() || "")
        .filter(Boolean),
    ),
  );

  const profiles = dedupeProfiles(
    modelNames.map((modelName) =>
      normalizeProfile(
        {
          id: makeProfileId(modelName),
          name: modelName,
          model: modelName,
          authToken: legacy.authToken,
          baseURL: legacy.baseURL,
        },
        fallback,
      ),
    ),
  );

  const safeProfiles = profiles.length ? profiles : [fallback];
  const activeProfile =
    safeProfiles.find((profile) => profile.model === legacy.selectedModel) ||
    safeProfiles[0];

  return {
    activeProfileId: activeProfile.id,
    profiles: safeProfiles,
  } satisfies RuntimeModelWorkspaceConfig;
}

function isWorkspaceConfig(value: unknown): value is RuntimeModelWorkspaceConfig {
  return Boolean(
    value &&
      typeof value === "object" &&
      "activeProfileId" in value &&
      "profiles" in value,
  );
}

function normalizeWorkspaceConfig(
  input?: Partial<RuntimeModelWorkspaceConfig> | null,
): RuntimeModelWorkspaceConfig {
  const fallback = getDefaultProfile();
  const incomingProfiles = Array.isArray(input?.profiles) ? input.profiles : [];
  const safeProfiles = dedupeProfiles(
    incomingProfiles.map((profile) => normalizeProfile(profile, fallback)),
  );
  const profiles = safeProfiles.length ? safeProfiles : [fallback];
  const activeProfileId =
    input?.activeProfileId &&
    profiles.some((profile) => profile.id === input.activeProfileId)
      ? input.activeProfileId
      : profiles[0].id;

  return {
    activeProfileId,
    profiles,
  };
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function getModelWorkspaceConfig() {
  try {
    const raw = await readFile(MODEL_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as RuntimeModelWorkspaceConfig | LegacyModelConfig;

    if (isWorkspaceConfig(parsed)) {
      return normalizeWorkspaceConfig(parsed);
    }

    return migrateLegacyConfig(parsed);
  } catch {
    const fallback = getDefaultProfile();
    return {
      activeProfileId: fallback.id,
      profiles: [fallback],
    } satisfies RuntimeModelWorkspaceConfig;
  }
}

export function getModelWorkspaceConfigSync() {
  if (!existsSync(MODEL_CONFIG_FILE)) {
    const fallback = getDefaultProfile();
    return {
      activeProfileId: fallback.id,
      profiles: [fallback],
    } satisfies RuntimeModelWorkspaceConfig;
  }

  try {
    const raw = readFileSync(MODEL_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as RuntimeModelWorkspaceConfig | LegacyModelConfig;

    if (isWorkspaceConfig(parsed)) {
      return normalizeWorkspaceConfig(parsed);
    }

    return migrateLegacyConfig(parsed);
  } catch {
    const fallback = getDefaultProfile();
    return {
      activeProfileId: fallback.id,
      profiles: [fallback],
    } satisfies RuntimeModelWorkspaceConfig;
  }
}

export function getActiveModelProfileSync() {
  const workspace = getModelWorkspaceConfigSync();
  return (
    workspace.profiles.find((profile) => profile.id === workspace.activeProfileId) ||
    workspace.profiles[0]
  );
}

export async function saveModelWorkspaceConfig(
  input: Partial<RuntimeModelWorkspaceConfig>,
) {
  await ensureDataDir();
  const current = await getModelWorkspaceConfig();
  const next = normalizeWorkspaceConfig({
    ...current,
    ...input,
    profiles: input.profiles ?? current.profiles,
  });

  for (const profile of next.profiles) {
    validateProfile(profile);
  }

  if (!next.profiles.some((profile) => profile.id === next.activeProfileId)) {
    throw new Error("当前激活模型不存在，请重新选择。");
  }

  await writeFile(MODEL_CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
