// CORS handling shared by every Edge Function. ALLOWED_ORIGIN should be set
// to your GitHub Pages origin in production (see README); it defaults to
// "*" only so local development against `supabase functions serve` works
// out of the box.
const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-cron-secret',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export function handleOptions(req) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  return null;
}
