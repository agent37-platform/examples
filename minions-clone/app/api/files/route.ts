import { NextResponse, type NextRequest } from 'next/server';
import { listFiles, uploadToInstance } from '@/server/services/files';
import { jsonError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST a multipart upload; the 'file' entry is forwarded to the shared instance. */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    if (!form.get('file')) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'No file provided.' } },
        { status: 400 },
      );
    }
    const uploaded = await uploadToInstance(form);
    return NextResponse.json(uploaded);
  } catch (err) {
    return jsonError(err);
  }
}

/** GET the list of uploaded attachments across all tasks. */
export async function GET() {
  try {
    const files = await listFiles();
    return NextResponse.json(files);
  } catch (err) {
    return jsonError(err);
  }
}
