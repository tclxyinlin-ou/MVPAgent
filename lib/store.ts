import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

export type IndexedDocument = {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "indexed" | "failed";
  source: "upload" | "workspace";
  storedPath: string;
  markdownPath: string;
  chunkCount: number;
};

type LegacyIndexedDocument = IndexedDocument & {
  textPath?: string;
  markdownPath?: string;
};

export type AppState = {
  documents: IndexedDocument[];
};

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const STATE_FILE = path.join(DATA_DIR, "state.json");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const MARKDOWN_DIR = path.join(DATA_DIR, "markdown");

const DEFAULT_STATE: AppState = {
  documents: [],
};

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(MARKDOWN_DIR, { recursive: true });
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeLegacyMarkdown(filename: string, chunks: string[]) {
  const content = chunks.join("\n\n").trim();
  return `# ${filename}\n\n${content}\n`;
}

async function migrateLegacyDocument(document: LegacyIndexedDocument) {
  if (document.markdownPath && (await fileExists(document.markdownPath))) {
    return document as IndexedDocument;
  }

  if (!document.textPath || !(await fileExists(document.textPath))) {
    return null;
  }

  try {
    const raw = await readFile(document.textPath, "utf8");
    const parsed = JSON.parse(raw) as { chunks?: string[] };
    const chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    const markdownPath = path.join(
      MARKDOWN_DIR,
      `${document.id.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_")}.md`,
    );

    await writeFile(
      markdownPath,
      normalizeLegacyMarkdown(document.filename, chunks),
      "utf8",
    );

    return {
      ...document,
      markdownPath,
      chunkCount: chunks.length || document.chunkCount,
    } satisfies IndexedDocument;
  } catch {
    return null;
  }
}

export async function readState(): Promise<AppState> {
  await ensureDataDir();

  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as AppState;
    const incoming = Array.isArray(parsed.documents)
      ? (parsed.documents as LegacyIndexedDocument[])
      : [];
    const migratedDocuments: IndexedDocument[] = [];

    for (const document of incoming) {
      if (document.markdownPath) {
        migratedDocuments.push(document as IndexedDocument);
        continue;
      }

      const migrated = await migrateLegacyDocument(document);
      if (migrated) {
        migratedDocuments.push(migrated);
      }
    }

    if (migratedDocuments.length !== incoming.length) {
      await writeState({ documents: migratedDocuments });
    } else if (incoming.some((document) => !("markdownPath" in document))) {
      await writeState({ documents: migratedDocuments });
    }

    return {
      documents: migratedDocuments,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export async function writeState(state: AppState) {
  await ensureDataDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
