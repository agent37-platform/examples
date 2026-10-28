import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(userId) {
  return createHmac('sha256', process.env.BROKER_SECRET).update(userId).digest('base64url');
}

export function mintToken(userId) {
  return `${userId}.${sign(userId)}`;
}

export function userFromToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(userId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}
