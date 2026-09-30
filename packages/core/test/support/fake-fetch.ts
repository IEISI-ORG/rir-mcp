import type { FetchLike } from '../../src/ports';

export interface FakeRoute {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export type FakeFetch = FetchLike & { calls: string[]; inits: RequestInit[] };

/** Serves canned responses by exact URL; unknown URLs get 404. Always yields a tick so calls can overlap. */
export function fakeFetch(routes: Record<string, FakeRoute | (() => FakeRoute)>): FakeFetch {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push(url);
    inits.push(init ?? {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const r = routes[url];
    const route = typeof r === 'function' ? r() : r;
    if (!route) return new Response('not found', { status: 404 });
    const body = route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body));
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/rdap+json', ...route.headers },
    });
  };
  return Object.assign(fn, { calls, inits });
}
