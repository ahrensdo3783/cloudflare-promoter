export interface Env {
  [key: string]: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        service: 'workers-release-promoter-fixture',
      });
    }

    if (url.pathname === '/version') {
      return json({
        timestamp: new Date().toISOString(),
        runtime: 'cloudflare-workers',
      });
    }

    return new Response(
      'Workers Release Promoter integration fixture is running.',
      {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  },
};
