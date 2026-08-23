// In-memory adapter for tests and demos: hands back a prepared draft
// snapshot (and optional raw documents) unchanged.

import type { DraftSnapshot, FetchOutput, InstitutionAdapter, RawDocument } from "./adapter";
import { validateDraftSnapshot } from "./adapter";

export const FIXTURE_VIA = "adapter.fixture@1";

export function fixtureAdapter(
  institution_id: string,
  snapshot: Omit<DraftSnapshot, "institution_id" | "fetched_at" | "via"> & Partial<DraftSnapshot>,
  raw: RawDocument[] = [],
): InstitutionAdapter {
  return {
    institution_id,
    via: FIXTURE_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const draft = validateDraftSnapshot(
        { institution_id, fetched_at: ctx.now.toISOString(), via: FIXTURE_VIA, ...snapshot },
        `fixture ${institution_id}`,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(draft, null, 2));
      return {
        raw: raw.length > 0 ? raw : [{ bytes, filename: `${institution_id}.json`, mime: "application/json", kind: "snapshot" }],
        snapshot: draft,
      };
    },
  };
}

/** An adapter that always fails, for the fetch-failure path. */
export function failingAdapter(institution_id: string, message = "connection refused"): InstitutionAdapter {
  return {
    institution_id,
    via: "adapter.failing@1",
    async fetch() {
      throw new Error(message);
    },
  };
}
