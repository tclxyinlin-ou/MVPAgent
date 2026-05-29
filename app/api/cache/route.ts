import { NextResponse } from "next/server";
import { clearAskCache, getAskCacheSize } from "@/lib/ask-cache";

export async function GET() {
  return NextResponse.json({
    ok: true,
    askCacheSize: await getAskCacheSize(),
  });
}

export async function DELETE() {
  const clearedCount = await clearAskCache();

  return NextResponse.json({
    ok: true,
    clearedCount,
    askCacheSize: 0,
  });
}
