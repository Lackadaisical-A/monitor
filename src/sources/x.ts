import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { findWatchCompany, isoDate, itemId } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

interface XPost {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  note_tweet?: { text?: string };
}

interface XUser {
  id: string;
  name?: string;
  username?: string;
  verified?: boolean;
}

interface XResponse {
  data?: XPost[];
  includes?: { users?: XUser[] };
  meta?: { newest_id?: string; result_count?: number };
}

export class XRecentSearchSource implements SourceAdapter {
  readonly descriptor = { id: "x-recent-search", name: "X recent search", type: "x", tier: "social" } as const;

  constructor(
    private readonly bearerToken: string,
    private readonly query: string,
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", this.query);
    url.searchParams.set("max_results", "100");
    url.searchParams.set("sort_order", "recency");
    url.searchParams.set("tweet.fields", "id,text,author_id,created_at,entities,note_tweet");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "id,name,username,verified");
    if (cursor) url.searchParams.set("since_id", cursor);

    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    }, this.timeoutMs);
    const payload = await response.json() as XResponse;
    const users = new Map((payload.includes?.users ?? []).map((user) => [user.id, user]));
    const discoveredAt = new Date().toISOString();
    const items: NormalizedItem[] = (payload.data ?? []).map((post) => {
      const author = post.author_id ? users.get(post.author_id) : undefined;
      const text = post.note_tweet?.text ?? post.text;
      const headline = text.replace(/\s+/g, " ").slice(0, 280);
      const username = author?.username ?? "i";
      const url = `https://x.com/${username}/status/${post.id}`;
      const company = findWatchCompany(text, this.watchlist);
      return {
        id: itemId(this.descriptor.id, post.id, url, headline),
        externalId: post.id,
        source: this.descriptor,
        headline,
        summary: text.slice(0, 4_000),
        url,
        author: author ? `${author.name ?? author.username ?? author.id}${author.verified ? " (verified)" : ""}` : null,
        publishedAt: isoDate(post.created_at, new Date()),
        discoveredAt,
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? null,
        provenance: "social",
        independenceKey: `social:x:${post.author_id ?? "unknown"}`,
        raw: post,
      };
    });
    return {
      items,
      cursor: payload.meta?.newest_id ?? cursor ?? undefined,
      diagnostics: { resultCount: payload.meta?.result_count ?? items.length },
    };
  }
}
