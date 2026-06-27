import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Agent37Error } from './agent37/client';
import { Agent37ConfigError } from './config';

/**
 * One place to turn thrown errors into the API's error envelope: { error: { code, message, hint? } }.
 * Every route's catch block calls this so the browser always sees a consistent, machine-readable shape.
 */
export function jsonError(err: unknown): NextResponse {
  if (err instanceof Agent37Error) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, hint: err.hint } },
      { status: err.status || 502 },
    );
  }
  if (err instanceof Agent37ConfigError) {
    return NextResponse.json({ error: { code: 'config_error', message: err.message } }, { status: 500 });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join('.');
    return NextResponse.json(
      { error: { code: 'invalid_request', message: first ? `${path ? path + ': ' : ''}${first.message}` : 'Invalid request.' } },
      { status: 400 },
    );
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error.';
  return NextResponse.json({ error: { code: 'internal_error', message } }, { status: 500 });
}
