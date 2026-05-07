import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { getModelName, getOpenAIClient } from "@/lib/openai";
import { readState } from "@/lib/store";

export const runtime = "nodejs";

type SearchResult = {
  filename: string;
  score: number;
  excerpt: string;
};

type StoredTextDocument = {
  filename: string;
  chunks: string[];
};

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreChunk(question: string, chunk: string) {
  const queryTokens = tokenize(question);
  const chunkTokens = new Set(tokenize(chunk));

  let matches = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      matches += 1;
    }
  }

  const phraseBonus = chunk.toLowerCase().includes(question.toLowerCase()) ? 3 : 0;
  return matches + phraseBonus;
}

async function searchDocuments(question: string) {
  const state = await readState();
  const results: SearchResult[] = [];

  for (const document of state.documents) {
    const raw = await readFile(document.textPath, "utf8");
    const parsed = JSON.parse(raw) as StoredTextDocument;

    for (const chunk of parsed.chunks) {
      const score = scoreChunk(question, chunk);
      if (score > 0) {
        results.push({
          filename: document.filename,
          score,
          excerpt: chunk,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 4);
}

function extractChatAnswer(response: unknown): string {
  const completion = response as
    | {
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
      }
    | undefined;

  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || "")
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { question?: string };
    const question = body.question?.trim();

    if (!question) {
      return NextResponse.json(
        { ok: false, error: "问题不能为空。" },
        { status: 400 },
      );
    }

    const state = await readState();
    if (state.documents.length === 0) {
      return NextResponse.json(
        { ok: false, error: "知识库还是空的，请先导入至少一份文档。" },
        { status: 400 },
      );
    }

    const sources = await searchDocuments(question);
    if (sources.length === 0) {
      return NextResponse.json({
        ok: true,
        answer: "没有在已导入文档里检索到足够相关的内容。请换个问法，或者先补充对应文档。",
        sources: [],
      });
    }

    const client = getOpenAIClient();
    const context = sources
      .map(
        (source, index) =>
          `[片段 ${index + 1}] 文档：${source.filename}\n${source.excerpt}`,
      )
      .join("\n\n");

    const response = await client.chat.completions.create({
      model: getModelName(),
      messages: [
        {
          role: "system",
          content:
            "你是一个内部文档问答助手。必须优先依据提供的文档片段回答，不要编造文档里没有的信息。如果证据不足，要直接说明。输出时先给结论，再给简短依据。",
        },
        {
          role: "user",
          content: `问题：${question}\n\n可用文档片段：\n${context}`,
        },
      ],
    });

    return NextResponse.json({
      ok: true,
      answer: extractChatAnswer(response),
      sources: sources.map((source) => ({
        filename: source.filename,
        score: source.score,
        excerpt: source.excerpt,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "提问失败，请稍后重试。";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
