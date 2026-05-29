import { readFile, unlink, writeFile } from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { chunkTextWithHeadings, normalizeText } from "@/lib/openai";
import { readState, writeState } from "@/lib/store";
import { marked } from "marked";
import TurndownService from "turndown";

export const runtime = "nodejs";
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

function cleanupMarkdownContent(content: string) {
  return content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/\n{3,}/g, "\n\n");
}

async function findDocument(id: string) {
  const state = await readState();
  const index = state.documents.findIndex((document) => document.id === id);

  if (index === -1) {
    return null;
  }

  return {
    state,
    index,
    document: state.documents[index],
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const target = await findDocument(id);

  if (!target) {
    return NextResponse.json(
      { ok: false, error: "文档不存在。" },
      { status: 404 },
    );
  }

  const rawMarkdown = await readFile(target.document.markdownPath, "utf8");
  const markdown = cleanupMarkdownContent(rawMarkdown);

  if (markdown !== rawMarkdown) {
    await writeFile(target.document.markdownPath, `${markdown.trimEnd()}\n`, "utf8");
  }

  const html = await marked.parse(markdown);

  return NextResponse.json({
    ok: true,
    document: {
      id: target.document.id,
      filename: target.document.filename,
      markdownPath: target.document.markdownPath,
      richTextPath: target.document.richTextPath,
      content: markdown,
      htmlContent: html,
    },
  });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json()) as { content?: string; htmlContent?: string };
  const content = typeof body.content === "string" ? body.content : "";
  const htmlContent = typeof body.htmlContent === "string" ? body.htmlContent : "";
  const target = await findDocument(id);

  if (!target) {
    return NextResponse.json(
      { ok: false, error: "文档不存在。" },
      { status: 404 },
    );
  }

  const nextMarkdownSource = htmlContent ? turndown.turndown(htmlContent) : content;
  const normalized = normalizeText(cleanupMarkdownContent(nextMarkdownSource));
  await writeFile(target.document.markdownPath, `${normalized}\n`, "utf8");
  await writeFile(
    target.document.richTextPath,
    htmlContent || (await marked.parse(`${normalized}\n`)),
    "utf8",
  );

  const nextChunks = chunkTextWithHeadings(normalized);
  const nextChunkCount = nextChunks.length;
  target.state.documents[target.index] = {
    ...target.document,
    chunkCount: nextChunkCount,
    chunks: nextChunks,
    updatedAt: new Date().toISOString(),
  };
  await writeState(target.state);

  return NextResponse.json({
    ok: true,
    chunkCount: nextChunkCount,
    markdownPath: target.document.markdownPath,
  });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const target = await findDocument(id);

  if (!target) {
    return NextResponse.json(
      { ok: false, error: "文档不存在。" },
      { status: 404 },
    );
  }

  target.state.documents.splice(target.index, 1);
  await writeState(target.state);

  await Promise.allSettled([
    unlink(target.document.storedPath),
    unlink(target.document.markdownPath),
    unlink(target.document.richTextPath),
  ]);

  return NextResponse.json({
    ok: true,
    deletedId: id,
  });
}
