// "Check for Updates…" (the app menu): ask GitHub for the newest
// published release of this project. The host does the one outbound
// call (like the ECB rates in fx.ts) so the shell needs no HTTP client
// and the GUI can compare the tag with the version it was built as.
// Nothing is downloaded or installed: the answer is a version and a
// link; the operator decides.

export const RELEASES_API_URL = "https://api.github.com/repos/brianjfox/personal-finance-intx/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/brianjfox/personal-finance-intx/releases";

export interface LatestRelease {
  /** The tag without its leading v, e.g. "0.5.0". */
  version: string;
  tag: string;
  name: string;
  url: string;
  published_at: string | null;
}

export interface UpdatesOptions {
  fetchImpl?: typeof fetch;
  api_url?: string;
}

export async function latestRelease(opts: UpdatesOptions = {}): Promise<LatestRelease> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await doFetch(opts.api_url ?? RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "corbits-personal-finance" },
      signal: ctl.signal,
    });
    if (r.status === 404) throw new Error("no published release yet");
    if (!r.ok) throw new Error(`GitHub answered ${String(r.status)}`);
    const body = (await r.json()) as { tag_name?: unknown; name?: unknown; html_url?: unknown; published_at?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    if (!/^v?\d+\.\d+\.\d+/.test(tag)) throw new Error("the release has no version tag");
    return {
      version: tag.replace(/^v/, ""),
      tag,
      name: typeof body.name === "string" && body.name !== "" ? body.name : tag,
      url: typeof body.html_url === "string" ? body.html_url : RELEASES_PAGE_URL,
      published_at: typeof body.published_at === "string" ? body.published_at : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
