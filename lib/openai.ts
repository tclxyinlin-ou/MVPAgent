import { execFile } from "child_process";
import OpenAI from "openai";
import { copyFile, readFile, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import {
  readState,
  TEXT_DIR,
  type IndexedDocument,
  UPLOAD_DIR,
  writeState,
} from "@/lib/store";

const execFileAsync = promisify(execFile);

function requireApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY。请先在 .env 中配置。");
  }
}

export function getOpenAIClient() {
  requireApiKey();
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
}

export async function ensureVectorStore() {
  return null;
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_");
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text: string, chunkSize = 900, overlap = 180) {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

async function extractTextFromDocument(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".txt" || extension === ".md") {
    return normalizeText(await readFile(filePath, "utf8"));
  }

  if ([".doc", ".docx", ".rtf", ".odt"].includes(extension)) {
    const { stdout } = await execFileAsync("textutil", [
      "-convert",
      "txt",
      "-stdout",
      filePath,
    ]);
    return normalizeText(stdout);
  }

  if (extension === ".pdf") {
    throw new Error("当前兼容模式暂不支持 PDF 解析，先用 docx/txt/md。");
  }

  throw new Error(`暂不支持 ${extension || "该格式"} 文件。`);
}

export async function indexDocumentLocally({
  filePath,
  filename,
  source,
}: {
  filePath: string;
  filename: string;
  source: IndexedDocument["source"];
}) {
  const state = await readState();
  const timestamp = Date.now();
  const safeFilename = sanitizeFilename(filename);
  const storedPath = path.join(UPLOAD_DIR, `${timestamp}-${safeFilename}`);
  const textPath = path.join(TEXT_DIR, `${timestamp}-${safeFilename}.json`);

  await copyFile(filePath, storedPath);

  const extractedText = await extractTextFromDocument(storedPath);
  if (!extractedText) {
    throw new Error("文档内容为空，无法建立索引。");
  }

  const chunks = chunkText(extractedText);

  await writeFile(
    textPath,
    JSON.stringify(
      {
        filename,
        extractedAt: new Date().toISOString(),
        chunks,
      },
      null,
      2,
    ),
    "utf8",
  );

  const nextDocument: IndexedDocument = {
    id: `${timestamp}:${safeFilename}`,
    filename,
    uploadedAt: new Date().toISOString(),
    status: "indexed",
    source,
    storedPath,
    textPath,
    chunkCount: chunks.length,
  };

  state.documents = [
    nextDocument,
    ...state.documents.filter((document) => document.filename !== filename),
  ];
  await writeState(state);

  return {
    documentId: nextDocument.id,
    chunkCount: chunks.length,
  };
}

export function getModelName() {
  return process.env.OPENAI_MODEL || "mimo-v2.5-pro";
}
