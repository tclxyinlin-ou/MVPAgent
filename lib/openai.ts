import { execFile } from "child_process";
import OpenAI from "openai";
import { copyFile, readFile, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import {
  MARKDOWN_DIR,
  readState,
  RICH_TEXT_DIR,
  type IndexedDocument,
  UPLOAD_DIR,
  writeState,
} from "@/lib/store";
import { getActiveModelProfileSync } from "@/lib/model-config";
import { marked } from "marked";

const execFileAsync = promisify(execFile);

export type DocumentChunk = {
  text: string;
  headingPath: string[];
  searchText: string;
};

function requireApiKey() {
  if (!getActiveModelProfileSync().authToken) {
    throw new Error("缺少模型密钥。请先在 .env 或模型设置里配置。");
  }
}

export function getOpenAIClient() {
  requireApiKey();
  const config = getActiveModelProfileSync();
  return new OpenAI({
    apiKey: config.authToken,
    baseURL: config.baseURL || undefined,
  });
}

export async function ensureVectorStore() {
  return null;
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_");
}

function getMarkdownFilename(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "");
  return `${sanitizeFilename(base)}.md`;
}

export function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlText(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\u00a0/g, " ");
}

async function unzipDocxEntry(filePath: string, entry: string) {
  const { stdout } = await execFileAsync("unzip", ["-p", filePath, entry]);
  return stdout;
}

function parseDocxHeadingStyles(stylesXml: string) {
  const headingStyles = new Map<string, number>();
  const styleRegex = /<w:style\b[^>]*?w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let match: RegExpExecArray | null;

  while ((match = styleRegex.exec(stylesXml))) {
    const [, styleId, styleBody] = match;
    const name = styleBody.match(/<w:name\b[^>]*?w:val="([^"]+)"/)?.[1]?.toLowerCase();
    const outline = styleBody.match(/<w:outlineLvl\b[^>]*?w:val="(\d+)"/)?.[1];
    const headingName = name?.match(/^heading\s+(\d+)$/);
    const titleName = name === "title";

    if (headingName) {
      headingStyles.set(styleId, Math.min(Number(headingName[1]), 6));
    } else if (outline !== undefined) {
      headingStyles.set(styleId, Math.min(Number(outline) + 1, 6));
    } else if (titleName) {
      headingStyles.set(styleId, 1);
    }
  }

  return headingStyles;
}

function extractDocxParagraphText(paragraphXml: string) {
  const parts: string[] = [];
  const tokenRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(paragraphXml))) {
    if (match[1] !== undefined) {
      parts.push(decodeXmlText(match[1]));
    } else if (match[0].startsWith("<w:tab")) {
      parts.push("\t");
    } else {
      parts.push("\n");
    }
  }

  return normalizeText(parts.join(""));
}

function docxXmlToMarkdown(documentXml: string, stylesXml: string) {
  const headingStyles = parseDocxHeadingStyles(stylesXml);
  const lines: string[] = [];
  const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;

  while ((match = paragraphRegex.exec(documentXml))) {
    const paragraphXml = match[1];
    const text = extractDocxParagraphText(paragraphXml);

    if (!text) {
      lines.push("");
      continue;
    }

    const styleId = paragraphXml.match(/<w:pStyle\b[^>]*?w:val="([^"]+)"/)?.[1];
    const headingLevel = styleId ? headingStyles.get(styleId) : undefined;

    if (headingLevel) {
      lines.push(`${"#".repeat(headingLevel)} ${text}`);
      continue;
    }

    if (/<w:numPr\b/.test(paragraphXml)) {
      lines.push(`- ${text}`);
      continue;
    }

    lines.push(text);
  }

  return normalizeText(lines.join("\n\n"));
}

const DEFAULT_CHUNK_SIZE = 420;
const DEFAULT_CHUNK_OVERLAP = 80;

type ChunkUnit = {
  text: string;
  headingPath: string[];
};

function splitIntoChunkUnits(text: string): ChunkUnit[] {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const headingStack: Array<{ level: number; text: string }> = [];
  const blocks: ChunkUnit[] = [];
  let currentLines: string[] = [];
  let currentHeadingPath: string[] = [];

  const flushBlock = () => {
    const blockText = normalizeText(currentLines.join("\n"));
    if (!blockText) {
      currentLines = [];
      return;
    }

    blocks.push({
      text: blockText,
      headingPath: [...currentHeadingPath],
    });
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushBlock();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      headingStack.push({ level, text });
      currentHeadingPath = headingStack.map((item) => item.text);
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  flushBlock();

  return blocks.flatMap((block) => {
    if (block.text.length <= DEFAULT_CHUNK_SIZE) {
      return [block];
    }

    const sentences = block.text
        .split(/(?<=[。！？!?；;]|[.](?=\s)|\n)/)
        .map((part) => part.trim())
        .filter(Boolean);

    const units = sentences.length ? sentences : [block.text];
    return units.map((text) => ({
      text,
      headingPath: block.headingPath,
    }));
  });
}

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
) {
  const units = splitIntoChunkUnits(text);
  const chunks: string[] = [];
  let current = "";

  const pushChunk = (value: string) => {
    const normalized = normalizeText(value);
    if (normalized) {
      chunks.push(normalized);
    }
  };

  for (const unit of units) {
    if (!current) {
      current = unit.text;
      continue;
    }

    const candidate = `${current}\n\n${unit.text}`;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    pushChunk(current);

    const tail = overlap > 0 ? current.slice(-overlap).trim() : "";
    current = tail ? `${tail}\n\n${unit.text}` : unit.text;

    while (current.length > chunkSize) {
      pushChunk(current.slice(0, chunkSize));
      current =
        overlap > 0
          ? current.slice(Math.max(chunkSize - overlap, 1)).trim()
          : current.slice(chunkSize).trim();
    }
  }

  pushChunk(current);

  return chunks.filter((chunk, index) => chunks.indexOf(chunk) === index);
}

export function chunkTextWithHeadings(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
): DocumentChunk[] {
  const units = splitIntoChunkUnits(text);
  const chunks: DocumentChunk[] = [];
  let currentText = "";
  let currentHeadingPath: string[] = [];

  const pushChunk = (value: string, headingPath: string[]) => {
    const textValue = normalizeText(value);
    if (!textValue) {
      return;
    }

    const headingText = headingPath.join(" > ").trim();
    const searchText = normalizeText(`${headingText}\n${textValue}`);
    chunks.push({
      text: textValue,
      headingPath: [...headingPath],
      searchText,
    });
  };

  for (const unit of units) {
    if (!currentText) {
      currentText = unit.text;
      currentHeadingPath = unit.headingPath;
      continue;
    }

    const sameHeadingPath =
      currentHeadingPath.join(" > ") === unit.headingPath.join(" > ");
    const candidate = `${currentText}\n\n${unit.text}`;

    if (sameHeadingPath && candidate.length <= chunkSize) {
      currentText = candidate;
      continue;
    }

    pushChunk(currentText, currentHeadingPath);

    const tail = overlap > 0 ? currentText.slice(-overlap).trim() : "";
    currentText = tail ? `${tail}\n\n${unit.text}` : unit.text;
    currentHeadingPath = unit.headingPath;

    while (currentText.length > chunkSize) {
      pushChunk(currentText.slice(0, chunkSize), currentHeadingPath);
      currentText =
        overlap > 0
          ? currentText.slice(Math.max(chunkSize - overlap, 1)).trim()
          : currentText.slice(chunkSize).trim();
    }
  }

  pushChunk(currentText, currentHeadingPath);

  return chunks.filter(
    (chunk, index) =>
      chunks.findIndex(
        (candidate) =>
          candidate.text === chunk.text &&
          candidate.headingPath.join(" > ") === chunk.headingPath.join(" > "),
      ) === index,
  );
}

async function extractTextFromDocument(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".txt" || extension === ".md") {
    return normalizeText(await readFile(filePath, "utf8"));
  }

  if (extension === ".docx") {
    try {
      const [documentXml, stylesXml] = await Promise.all([
        unzipDocxEntry(filePath, "word/document.xml"),
        unzipDocxEntry(filePath, "word/styles.xml").catch(() => ""),
      ]);
      const markdown = docxXmlToMarkdown(documentXml, stylesXml);
      if (markdown) {
        return markdown;
      }
    } catch {
      // Fall back to textutil for malformed or non-standard docx files.
    }
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

function toMarkdownDocument(filename: string, text: string) {
  return `# ${filename}\n\n${text}\n`;
}

export async function readMarkdownChunks(markdownPath: string) {
  const markdown = normalizeText(await readFile(markdownPath, "utf8"));
  return chunkTextWithHeadings(markdown);
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
  const markdownPath = path.join(
    MARKDOWN_DIR,
    `${timestamp}-${getMarkdownFilename(filename)}`,
  );
  const richTextPath = path.join(
    RICH_TEXT_DIR,
    `${timestamp}-${sanitizeFilename(filename.replace(/\.[^.]+$/, ""))}.html`,
  );

  await copyFile(filePath, storedPath);

  const extractedText = await extractTextFromDocument(storedPath);
  if (!extractedText) {
    throw new Error("文档内容为空，无法建立索引。");
  }

  const markdownContent = toMarkdownDocument(filename, extractedText);
  await writeFile(markdownPath, markdownContent, "utf8");
  await writeFile(richTextPath, await marked.parse(markdownContent), "utf8");
  const chunks = chunkTextWithHeadings(normalizeText(markdownContent));

  const nextDocument: IndexedDocument = {
    id: `${timestamp}:${safeFilename}`,
    filename,
    uploadedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "indexed",
    source,
    storedPath,
    markdownPath,
    richTextPath,
    chunkCount: chunks.length,
    chunks,
  };

  state.documents = [
    nextDocument,
    ...state.documents.filter((document) => document.filename !== filename),
  ];
  await writeState(state);

  return {
    documentId: nextDocument.id,
    markdownPath: nextDocument.markdownPath,
    richTextPath: nextDocument.richTextPath,
    chunkCount: chunks.length,
  };
}

export function getModelName() {
  return getActiveModelProfileSync().model || "gpt-5.4";
}
