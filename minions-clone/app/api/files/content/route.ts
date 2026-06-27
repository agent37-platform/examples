import { NextResponse, type NextRequest } from 'next/server';
import { openFileDownload } from '@/server/services/files';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stream a file's bytes back to the browser as a download. */
export async function GET(req: NextRequest) {
  try {
    const path = req.nextUrl.searchParams.get('path');
    if (!path) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'No path provided.' } },
        { status: 400 },
      );
    }
    const upstream = await openFileDownload(path, req.signal);
    const filename = path.split('/').pop() ?? 'download';
    return new Response(upstream.body, {
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
