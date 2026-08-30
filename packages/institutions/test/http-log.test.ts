// The fetch-log wire capture: every exchange reaches the sink, and
// redaction masks credentials before anything is stored or shown.

import { describe, expect, test } from "bun:test";

import { loggingFetch, redactHttpEntry, type HttpLogEntry } from "../src/adapter";

describe("loggingFetch", () => {
  test("reports method, url, headers, bodies; response stays readable", async () => {
    const entries: HttpLogEntry[] = [];
    const impl = (async () =>
      new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "r1" } })) as unknown as typeof fetch;
    const wrapped = loggingFetch(impl, () => (e) => entries.push(e));
    const r = await wrapped("https://api.example.com/thing", {
      method: "POST",
      headers: { authorization: "Bearer supersecretvalue123", "content-type": "application/json" },
      body: JSON.stringify({ access_token: "tok-123456789012", q: 1 }),
    });
    expect((await r.json()) as unknown).toEqual({ hello: "world" });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.method).toBe("POST");
    expect(e.url).toBe("https://api.example.com/thing");
    expect(e.status).toBe(200);
    expect(e.response_headers["x-request-id"]).toBe("r1");
    expect(e.response_body).toContain("hello");
  });

  test("no sink armed: passthrough, nothing recorded", async () => {
    const impl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const wrapped = loggingFetch(impl, () => null);
    const r = await wrapped("https://api.example.com/x");
    expect(r.status).toBe(200);
  });

  test("a network error is recorded as status 0, then rethrown", async () => {
    const entries: HttpLogEntry[] = [];
    const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const wrapped = loggingFetch(impl, () => (e) => entries.push(e));
    await expect(wrapped("https://api.example.com/x")).rejects.toThrow("ECONNREFUSED");
    expect(entries[0]!.status).toBe(0);
    expect(entries[0]!.response_body).toContain("ECONNREFUSED");
  });
});

describe("redactHttpEntry", () => {
  test("masks credential headers and body fields, keeps the rest", () => {
    const e: HttpLogEntry = {
      at: "2026-08-30T00:00:00.000Z",
      method: "POST",
      url: "https://production.plaid.com/accounts/balance/get",
      request_headers: { authorization: "Bearer verylongsecretbearertoken", "content-type": "application/json" },
      request_body: JSON.stringify({ client_id: "cid", secret: "plaid-secret-value-9876", access_token: "access-sandbox-12345678", options: { count: 500 } }),
      status: 200,
      response_headers: { "set-cookie": "session=abcdefghijklmnop", "content-type": "application/json" },
      response_body: JSON.stringify({ accounts: [], request_id: "ok" }),
      ms: 12,
    };
    const r = redactHttpEntry(e);
    expect(r.request_headers["authorization"]).not.toContain("verylongsecret");
    expect(r.request_headers["authorization"]).toContain("••••");
    expect(r.request_headers["content-type"]).toBe("application/json");
    expect(r.response_headers["set-cookie"]).toContain("••••");
    expect(r.request_body).not.toContain("plaid-secret-value-9876");
    expect(r.request_body).not.toContain("access-sandbox-12345678");
    expect(r.request_body).toContain('"client_id":"cid"');
    expect(r.request_body).toContain('"count":500');
    expect(r.response_body).toContain("request_id");
  });
});
