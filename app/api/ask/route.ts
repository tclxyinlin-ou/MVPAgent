import { NextRequest, NextResponse } from "next/server";
import {
  executeFastDocumentPlan,
  generateFinalAnswer,
  streamFinalAnswer,
} from "@/lib/agent";
import { readState } from "@/lib/store";

export const runtime = "nodejs";

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

const ASK_CACHE = new Map<string, CachedAnswer>();
const ASK_CACHE_LIMIT = 80;

async function getCacheKey(question: string, documentId?: string) {
  const state = await readState();
  const documentVersions = documentId
    ? state.documents
        .filter((document) => document.id === documentId)
        .map((document) => `${document.id}:${document.updatedAt || document.uploadedAt}:${document.chunkCount}`)
    : state.documents.map(
        (document) => `${document.id}:${document.updatedAt || document.uploadedAt}:${document.chunkCount}`,
      );

  return `${documentVersions.join("|")}::${question.trim().toLowerCase()}`;
}

function writeAskCache(key: string, value: CachedAnswer) {
  if (ASK_CACHE.size >= ASK_CACHE_LIMIT) {
    const oldestKey = ASK_CACHE.keys().next().value as string | undefined;
    if (oldestKey) {
      ASK_CACHE.delete(oldestKey);
    }
  }

  ASK_CACHE.set(key, value);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      question?: string;
      documentId?: string;
    };
    const question = body.question?.trim();
    const documentId = body.documentId?.trim();

    if (!question) {
      return NextResponse.json(
        { ok: false, error: "问题不能为空。" },
        { status: 400 },
      );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };

        try {
          const cacheKey = await getCacheKey(question, documentId);
          const cached = ASK_CACHE.get(cacheKey);

          if (cached) {
            send({
              type: "steps",
              steps: [
                ...cached.steps,
                {
                  tool: "cache",
                  summary: "命中最近问答缓存，直接返回结果",
                },
              ],
            });
            send({
              type: "sources",
              sources: cached.sources,
            });
            send({
              type: "debug",
              debug: cached.debug || {
                questionType: "direct",
                intentKind: "exact_value",
                answerMode: "exact_value",
                environment: null,
                targetField: null,
                hitCount: cached.sources.length,
                strongHitCount: cached.sources.length,
                topScore: cached.sources[0]?.score ?? null,
                topSourceFilename: cached.sources[0]?.filename ?? null,
                refusalReason: null,
              },
            });
            send({
              type: "answer",
              delta: cached.answer,
            });
            send({ type: "done" });
            controller.close();
            return;
          }

          const plan = await executeFastDocumentPlan(question, documentId);

          send({
            type: "steps",
            steps: plan.steps,
          });
          send({
            type: "sources",
            sources: plan.sources,
          });
          send({
            type: "debug",
            debug: plan.debug,
          });

          if (plan.sources.length === 0) {
            send({
              type: "answer",
              delta:
                "没有在已导入文档里检索到足够相关的内容。请换个问法，或者先补充对应文档。",
            });
            send({ type: "done" });
            controller.close();
            return;
          }

          if (!plan.shouldAnswer) {
            send({
              type: "answer",
              delta:
                "检索到了部分相关内容，但证据强度还不够，暂时无法可靠回答。请换个更具体的问法，或补充对应文档后再试。",
            });
            send({ type: "done" });
            controller.close();
            return;
          }

          let hasDelta = false;
          let finalAnswer = "";

          try {
            finalAnswer = await streamFinalAnswer(question, plan.sources, (delta) => {
              hasDelta = true;
              send({
                type: "answer",
                delta,
              });
            });
          } catch {
            const fallback = await generateFinalAnswer(question, plan.sources);
            finalAnswer = fallback;
            hasDelta = true;
            send({
              type: "answer",
              delta: fallback,
            });
          }

          if (!hasDelta) {
            const fallback = await generateFinalAnswer(question, plan.sources);
            finalAnswer = fallback;
            send({
              type: "answer",
              delta: fallback,
            });
          }

          if (finalAnswer) {
            writeAskCache(cacheKey, {
              answer: finalAnswer,
              steps: plan.steps,
              sources: plan.sources,
              debug: plan.debug,
              createdAt: Date.now(),
            });
          }

          send({ type: "done" });
          controller.close();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "提问失败，请稍后重试。";

          send({
            type: "error",
            error: message,
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "提问失败，请稍后重试。";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
