import { NextResponse } from 'next/server';
import { provisionInstanceNow } from '@/server/services/settings';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const instanceId = await provisionInstanceNow();
    return NextResponse.json({ instanceId });
  } catch (err) {
    return jsonError(err);
  }
}
