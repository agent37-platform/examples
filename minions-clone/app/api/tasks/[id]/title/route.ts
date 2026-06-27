import { NextResponse } from 'next/server';
import { generateTaskTitle } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST to auto-generate the task's title from its first exchange. Idempotent: if a title was
// already generated or edited, the existing one is returned. The client calls this once after
// the first turn completes.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const title = await generateTaskTitle(id);
    if (title === null) {
      return NextResponse.json({ error: { code: 'task_not_found', message: 'No such task.' } }, { status: 404 });
    }
    return NextResponse.json({ title });
  } catch (err) {
    return jsonError(err);
  }
}
