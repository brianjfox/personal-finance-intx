// The app menu's "Check for Updates…": one GitHub call, a version and a
// link back, and plain errors when GitHub says no.

import { describe, expect, test } from "bun:test";

import { latestRelease, RELEASES_API_URL } from "../src/updates";

const fetchWith = (status: number, body: unknown, seen: string[] = []): typeof fetch =>
  (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("latestRelease", () => {
  test("reads the tag, name, and link from GitHub's latest-release answer", async () => {
    const seen: string[] = [];
    const r = await latestRelease({ fetchImpl: fetchWith(200, { tag_name: "v0.5.0", name: "Corbits Personal Finance 0.5.0", html_url: "https://github.com/x/releases/tag/v0.5.0", published_at: "2026-09-05T11:13:55Z" }, seen) });
    expect(seen).toEqual([RELEASES_API_URL]);
    expect(r).toEqual({ version: "0.5.0", tag: "v0.5.0", name: "Corbits Personal Finance 0.5.0", url: "https://github.com/x/releases/tag/v0.5.0", published_at: "2026-09-05T11:13:55Z" });
  });

  test("no release, a server error, and a tag without a version are plain errors", async () => {
    expect(latestRelease({ fetchImpl: fetchWith(404, { message: "Not Found" }) })).rejects.toThrow(/no published release/);
    expect(latestRelease({ fetchImpl: fetchWith(503, {}) })).rejects.toThrow(/503/);
    expect(latestRelease({ fetchImpl: fetchWith(200, { tag_name: "nightly" }) })).rejects.toThrow(/no version tag/);
  });
});
