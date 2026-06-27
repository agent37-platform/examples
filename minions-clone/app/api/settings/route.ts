import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppSettings, updateAppSettings } from '@/server/services/settings';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  defaultModel: z.string().nullable().optional(),
  defaultProvider: z.string().nullable().optional(),
});

export async function GET() {
  try {
    const settings = await getAppSettings();
    return NextResponse.json(settings);
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = patchSchema.parse(body);
    const settings = await updateAppSettings(parsed);
    return NextResponse.json(settings);
  } catch (err) {
    return jsonError(err);
  }
}
