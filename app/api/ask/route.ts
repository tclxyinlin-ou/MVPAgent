import { NextRequest, NextResponse } from "next/server";
import {
  executeFastDocumentPlan,
  generateFinalAnswer,
  streamFinalAnswer,
} from "@/lib/agent";
import { writeAskCache } from "@/lib/ask-cache";
import { readState } from "@/lib/store";

export const runtime = "nodejs";

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
            await writeAskCache(cacheKey, {
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
