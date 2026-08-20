import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { findWatchCompany, isoDate, itemId } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

interface RedditPost {
  id: string;
  name: string;
  title: string;
  selftext?: string;
  url: string;
  permalink: string;
  author?: string;
  created_utc: number;
  subreddit?: string;
  score?: number;
  num_comments?: number;
}

interface RedditListing {
  data?: { children?: Array<{ data: RedditPost }> };
}

export class RedditSource implements SourceAdapter {
  readonly descriptor = { id: "reddit-new", name: "Reddit", type: "reddit", tier: "social" } as const;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly credentials: { clientId: string; clientSecret: string; userAgent: string; subreddits: string },
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const accessToken = await this.getAccessToken();
    const url = new URL(`https://oauth.reddit.com/r/${this.credentials.subreddits}/new`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("raw_json", "1");
    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": this.credentials.userAgent,
      },
    }, this.timeoutMs);
    const listing = await response.json() as RedditListing;
    const since = cursor ? Number(cursor) : 0;
    const posts = (listing.data?.children ?? []).map((child) => child.data).filter((post) => post.created_utc > since);
    const discoveredAt = new Date().toISOString();
    const items: NormalizedItem[] = posts.map((post) => {
      const summary = (post.selftext ?? "").slice(0, 8_000);
      const company = findWatchCompany(`${post.title} ${summary}`, this.watchlist);
      const canonical = `https://www.reddit.com${post.permalink}`;
      return {
        id: itemId(this.descriptor.id, post.name || post.id, canonical, post.title),
        externalId: post.name || post.id,
        source: this.descriptor,
        headline: post.title,
        summary,
        url: canonical,
        author: post.author ?? null,
        publishedAt: isoDate(new Date(post.created_utc * 1000)),
        discoveredAt,
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? null,
        raw: post,
      };
    });
    const newest = posts.reduce((max, post) => Math.max(max, post.created_utc), since);
    return { items, cursor: newest ? String(newest) : cursor ?? undefined, diagnostics: { resultCount: items.length } };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const response = await fetchWithTimeout("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.credentials.userAgent,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    }, this.timeoutMs);
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error("Reddit OAuth response did not contain an access token");
    this.accessToken = payload.access_token;
    this.tokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return payload.access_token;
  }
}
