import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteTasksInColumn } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  column: z.enum(['in_progress', 'ready_for_review', 'complete']),
});

// POST { column } -> delete every task in that board column. Returns { deleted: count }.
export async function POST(req: Request) {
  try {
    const { column } = BodySchema.parse(await req.json());
    const deleted = await deleteTasksInColumn(column);
    return NextResponse.json({ deleted });
  } catch (err) {
    return jsonError(err);
  }
}
