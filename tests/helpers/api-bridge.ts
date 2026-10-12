/**
 * The browser's half of an end-to-end test.
 *
 * `AdminAlertDetail` calls `fetch("/api/admin/alerts/<id>")`. A test running in
 * jsdom has no dev server, so those calls are dispatched to the REAL route
 * handler modules and the caller's session cookie is attached the way a browser
 * would attach it. Everything after that is real too: the route builds a
 * Supabase client from the request cookies, `@supabase/ssr` talks to the
 * project in `NEXT_PUBLIC_SUPABASE_URL` (a local stub server in the tests), and
 * the assertion ends up being about the wire.
 */
export async function dispatchApiRequest(url: URL, init: RequestInit | undefined, cookieHeader: string): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

  const request = new Request(url.toString(), {
    method: init?.method ?? "GET",
    headers,
    body: init?.body as BodyInit | null | undefined,
  });

  const path = url.pathname;

  const reply = /^\/api\/admin\/alerts\/([^/]+)\/reply$/.exec(path);
  if (reply) {
    const { POST } = await import("../../src/app/api/admin/alerts/[id]/reply/route");
    return POST(request, { params: Promise.resolve({ id: decodeURIComponent(reply[1]) }) });
  }

  const resolve = /^\/api\/admin\/alerts\/([^/]+)\/resolve$/.exec(path);
  if (resolve) {
    const { POST } = await import("../../src/app/api/admin/alerts/[id]/resolve/route");
    return POST(request, { params: Promise.resolve({ id: decodeURIComponent(resolve[1]) }) });
  }

  const detail = /^\/api\/admin\/alerts\/([^/]+)$/.exec(path);
  if (detail) {
    const route = await import("../../src/app/api/admin/alerts/[id]/route");
    const context = { params: Promise.resolve({ id: decodeURIComponent(detail[1]) }) };
    return request.method === "POST" ? route.POST(request, context) : route.GET(request, context);
  }

  if (path === "/api/admin/alerts") {
    const { GET } = await import("../../src/app/api/admin/alerts/route");
    return GET(request);
  }

  throw new Error(`No route handler is wired for ${init?.method ?? "GET"} ${path}`);
}
