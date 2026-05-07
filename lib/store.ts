import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

export type IndexedDocument = {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "indexed" | "failed";
  source: "upload" | "workspace";
  storedPath: string;
  textPath: string;
  chunkCount: number;
};

export type AppState = {
  documents: IndexedDocument[];
};

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const STATE_FILE = path.join(DATA_DIR, "state.json");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const TEXT_DIR = path.join(DATA_DIR, "texts");

const DEFAULT_STATE: AppState = {
  documents: [],
};

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(TEXT_DIR, { recursive: true });
}

export async function readState(): Promise<AppState> {
  await ensureDataDir();

  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as AppState;
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function writeState(state: AppState) {
  await ensureDataDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
