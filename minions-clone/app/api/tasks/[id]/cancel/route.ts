import { NextResponse } from 'next/server';
import { cancelTask } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const task = await cancelTask(id);
    if (!task) {
      return NextResponse.json(
        { error: { code: 'task_not_found', message: 'No such task.' } },
        { status: 404 },
      );
    }
    return NextResponse.json(task);
  } catch (err) {
    return jsonError(err);
  }
}
