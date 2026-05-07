import { NextResponse } from "next/server";
import { readState } from "@/lib/store";

export async function GET() {
  const state = await readState();

  return NextResponse.json({
    ok: true,
    documents: state.documents,
  });
}
