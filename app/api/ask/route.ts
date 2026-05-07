import { NextRequest, NextResponse } from "next/server";
import {
  executeAgentPlan,
  generateFinalAnswer,
  streamFinalAnswer,
} from "@/lib/agent";

export const runtime = "nodejs";

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
          const plan = await executeAgentPlan(question, documentId);

          send({
            type: "steps",
            steps: plan.steps,
          });
          send({
            type: "sources",
            sources: plan.sources,
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

          let hasDelta = false;

          try {
            await streamFinalAnswer(question, plan.sources, (delta) => {
              hasDelta = true;
              send({
                type: "answer",
                delta,
              });
            });
          } catch {
            const fallback = await generateFinalAnswer(question, plan.sources);
            hasDelta = true;
            send({
              type: "answer",
              delta: fallback,
            });
          }

          if (!hasDelta) {
            const fallback = await generateFinalAnswer(question, plan.sources);
            send({
              type: "answer",
              delta: fallback,
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
