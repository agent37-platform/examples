import { openTaskStream } from '@/server/services/tasks';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const stream = await openTaskStream(id, req.signal);
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
