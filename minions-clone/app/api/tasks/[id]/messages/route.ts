import { z } from 'zod';
import { sendFollowup } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ input: z.string().trim().min(1, 'A message is required.') });

// POST a follow-up turn in the task's session. Returns the SSE stream for that turn (the route
// tees it server-side to persist the assistant message and the new status).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { input } = BodySchema.parse(await req.json());
    const stream = await sendFollowup(id, input, req.signal);
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
