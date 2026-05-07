import { unlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { indexDocumentLocally } from "@/lib/openai";

export const runtime = "nodejs";

async function uploadFromWorkspace(samplePath: string) {
  const filename = path.basename(samplePath);

  return indexDocumentLocally({
    filePath: samplePath,
    filename,
    source: "workspace",
  });
}

async function uploadFromFormData(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `${Date.now()}-${file.name}`);

  await writeFile(tempPath, buffer);

  try {
    return await indexDocumentLocally({
      filePath: tempPath,
      filename: file.name,
      source: "upload",
    });
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { samplePath?: string };
      if (!body.samplePath) {
        return NextResponse.json(
          { ok: false, error: "缺少 samplePath。" },
          { status: 400 },
        );
      }

      const result = await uploadFromWorkspace(body.samplePath);
      return NextResponse.json({ ok: true, ...result });
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "没有接收到文件。" },
        { status: 400 },
      );
    }

    const result = await uploadFromFormData(file);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "上传失败，请稍后重试。";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
