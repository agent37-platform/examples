import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createTask, listTasks } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tasks = await listTasks();
    return NextResponse.json(tasks);
  } catch (err) {
    return jsonError(err);
  }
}

const attachmentSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1),
  bytes: z.number(),
});

const createTaskSchema = z.object({
  prompt: z.string().min(1, 'A prompt is required.'),
  priority: z.enum(['low', 'medium', 'high']),
  mode: z.enum(['goal', 'ask']),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  attachments: z.array(attachmentSchema).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createTaskSchema.parse(body);
    const task = await createTask(parsed);
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
