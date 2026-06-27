import { NextResponse } from 'next/server';
import { getModelOptions } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const options = await getModelOptions();
    return NextResponse.json(options);
  } catch (err) {
    return jsonError(err);
  }
}
