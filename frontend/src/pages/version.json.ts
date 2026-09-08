import type { APIRoute } from 'astro';
import { BUILD } from '../lib/build.ts';

export const GET: APIRoute = () => new Response(JSON.stringify(BUILD), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
