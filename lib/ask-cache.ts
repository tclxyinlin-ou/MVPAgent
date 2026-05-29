import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

type CachedAnswer = {
  answer: string;
  steps: Array<{
    tool: string;
    summary: string;
  }>;
  sources: Array<{
    filename: string;
    score: number | null;
    excerpt: string;
  }>;
  debug?: {
    questionType: "overview" | "direct";
    hitCount: number;
    strongHitCount: number;
    topScore: number | null;
    topSourceFilename: string | null;
    refusalReason: string | null;
  };
  createdAt: number;
};

type AskCacheState = {
  items: Record<string, CachedAnswer>;
};

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const ASK_CACHE_FILE = path.join(DATA_DIR, "ask-cache.json");
const ASK_CACHE_LIMIT = 80;

const DEFAULT_CACHE_STATE: AskCacheState = {
  items: {},
};

let memoryCache: AskCacheState | null = null;

async function ensureCacheDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readAskCacheState() {
  if (memoryCache) {
    return memoryCache;
  }

  await ensureCacheDir();

  try {
    const raw = await readFile(ASK_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as AskCacheState;
    memoryCache = {
      items: parsed.items || {},
    };
    return memoryCache;
  } catch {
    memoryCache = { ...DEFAULT_CACHE_STATE };
    return memoryCache;
  }
}

async function writeAskCacheState(state: AskCacheState) {
  await ensureCacheDir();
  memoryCache = state;
  await writeFile(ASK_CACHE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function writeAskCache(key: string, value: CachedAnswer) {
  const state = await readAskCacheState();
  const items = {
    ...state.items,
    [key]: value,
  };

  const entries = Object.entries(items).sort(
    (a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0),
  );
  const trimmedEntries = entries.slice(0, ASK_CACHE_LIMIT);

  await writeAskCacheState({
    items: Object.fromEntries(trimmedEntries),
  });
}

export async function clearAskCache() {
  const state = await readAskCacheState();
  const size = Object.keys(state.items).length;

  await writeAskCacheState({
    items: {},
  });

  return size;
}

export async function getAskCacheSize() {
  const state = await readAskCacheState();
  return Object.keys(state.items).length;
}
