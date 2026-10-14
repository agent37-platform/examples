import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteTask, getTaskDetail, renameTask, setTaskSortOrder, setTaskStatus } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () =>
  NextResponse.json({ error: { code: 'task_not_found', message: 'No such task.' } }, { status: 404 });

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    // 'queued' is the board's "reopen / move to In Progress" target (no agent re-run).
    status: z.enum(['completed', 'ready_for_review', 'queued']).optional(),
    sortOrder: z.number().finite().optional(),
  })
  .refine((v) => v.title !== undefined || v.status !== undefined || v.sortOrder !== undefined, {
    message: 'Provide a title, status, or sortOrder to update.',
  });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const task = await getTaskDetail(id);
    return task ? NextResponse.json(task) : notFound();
  } catch (err) {
    return jsonError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const patch = PatchSchema.parse(await req.json());
    if (patch.title !== undefined) {
      const renamed = await renameTask(id, patch.title);
      if (!renamed) return notFound();
    }
    if (patch.status !== undefined) {
      // status + optional sortOrder together (a cross-column drag).
      const updated = await setTaskStatus(id, patch.status, patch.sortOrder);
      if (!updated) return notFound();
    } else if (patch.sortOrder !== undefined) {
      // sortOrder alone (an intra-column reorder).
      const updated = await setTaskSortOrder(id, patch.sortOrder);
      if (!updated) return notFound();
    }
    const task = await getTaskDetail(id);
    return task ? NextResponse.json(task) : notFound();
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const deleted = await deleteTask(id);
    return deleted ? NextResponse.json({ deleted: true }) : notFound();
  } catch (err) {
    return jsonError(err);
  }
}
