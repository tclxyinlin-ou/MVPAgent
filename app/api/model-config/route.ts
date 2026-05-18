import { NextRequest, NextResponse } from "next/server";
import {
  getModelWorkspaceConfig,
  saveModelWorkspaceConfig,
  type ModelProfile,
} from "@/lib/model-config";

export const runtime = "nodejs";

export async function GET() {
  const config = await getModelWorkspaceConfig();

  return NextResponse.json({
    ok: true,
    config,
  });
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      activeProfileId?: string;
      profiles?: ModelProfile[];
    };

    const config = await saveModelWorkspaceConfig({
      activeProfileId: body.activeProfileId,
      profiles: Array.isArray(body.profiles) ? body.profiles : undefined,
    });

    return NextResponse.json({
      ok: true,
      config,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "保存模型配置失败。";

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
