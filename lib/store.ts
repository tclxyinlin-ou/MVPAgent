import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { chunkTextWithHeadings, type DocumentChunk } from "@/lib/openai";

export type IndexedDocument = {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "indexed" | "failed";
  source: "upload" | "workspace";
  storedPath: string;
  markdownPath: string;
  richTextPath: string;
  chunkCount: number;
  chunks?: DocumentChunk[];
  updatedAt?: string;
};

type LegacyIndexedDocument = IndexedDocument & {
  textPath?: string;
  markdownPath?: string;
  richTextPath?: string;
};

export type AppState = {
  documents: IndexedDocument[];
};

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const STATE_FILE = path.join(DATA_DIR, "state.json");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const MARKDOWN_DIR = path.join(DATA_DIR, "markdown");
export const RICH_TEXT_DIR = path.join(DATA_DIR, "rich-text");

const DEFAULT_STATE: AppState = {
  documents: [],
};

function normalizeStoredText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeChunk(chunk: string | DocumentChunk): DocumentChunk {
  if (typeof chunk === "string") {
    return {
      text: chunk,
      headingPath: [],
      searchText: chunk,
    };
  }

  return {
    text: chunk.text,
    headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath : [],
    searchText: chunk.searchText || `${chunk.headingPath?.join(" > ") || ""}\n${chunk.text}`.trim(),
  };
}

function chunkStoredText(text: string) {
  return chunkTextWithHeadings(text);
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(MARKDOWN_DIR, { recursive: true });
  await mkdir(RICH_TEXT_DIR, { recursive: true });
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeLegacyMarkdown(filename: string, chunks: Array<string | DocumentChunk>) {
  const content = chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : chunk.text))
    .join("\n\n")
    .trim();
  return `# ${filename}\n\n${content}\n`;
}

async function migrateLegacyDocument(document: LegacyIndexedDocument) {
  if (
    document.markdownPath &&
    (await fileExists(document.markdownPath)) &&
    document.richTextPath &&
    (await fileExists(document.richTextPath))
  ) {
    return document as IndexedDocument;
  }

  if (!document.textPath || !(await fileExists(document.textPath))) {
    return null;
  }

  try {
    const raw = await readFile(document.textPath, "utf8");
    const parsed = JSON.parse(raw) as { chunks?: Array<string | DocumentChunk> };
    const chunks = Array.isArray(parsed.chunks) ? parsed.chunks.map(normalizeChunk) : [];
    const markdownPath = path.join(
      MARKDOWN_DIR,
      `${document.id.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_")}.md`,
    );
    const richTextPath = path.join(
      RICH_TEXT_DIR,
      `${document.id.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_")}.html`,
    );
    const markdown = normalizeLegacyMarkdown(document.filename, chunks);

    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(
      richTextPath,
      `<h1>${document.filename}</h1><p>${markdown
        .replace(/\n/g, "<br/>")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</p>`,
      "utf8",
    );

    return {
      ...document,
      markdownPath,
      richTextPath,
      chunkCount: chunks.length || document.chunkCount,
      chunks,
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
    let shouldRewriteState = false;

    for (const document of incoming) {
      if (document.markdownPath && document.richTextPath) {
        const nextDocument = document as IndexedDocument;

        if (!Array.isArray(nextDocument.chunks) && (await fileExists(nextDocument.markdownPath))) {
          const markdown = normalizeStoredText(await readFile(nextDocument.markdownPath, "utf8"));
          nextDocument.chunks = chunkStoredText(markdown);
          nextDocument.chunkCount = nextDocument.chunks.length;
          shouldRewriteState = true;
        } else if (Array.isArray(nextDocument.chunks)) {
          const normalizedChunks = nextDocument.chunks.map(normalizeChunk);
          const needsUpgrade = normalizedChunks.some(
            (chunk) => chunk.headingPath.length === 0 && /^#{1,6}\s/m.test(chunk.text),
          );

          if (needsUpgrade && (await fileExists(nextDocument.markdownPath))) {
            const markdown = normalizeStoredText(await readFile(nextDocument.markdownPath, "utf8"));
            nextDocument.chunks = chunkStoredText(markdown);
            nextDocument.chunkCount = nextDocument.chunks.length;
            shouldRewriteState = true;
          } else {
            nextDocument.chunks = normalizedChunks;
            nextDocument.chunkCount = normalizedChunks.length;
          }
        }

        migratedDocuments.push(nextDocument);
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
    } else if (shouldRewriteState) {
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
