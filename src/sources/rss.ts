import { XMLParser } from "fast-xml-parser";
import type { RssSourceConfig } from "../config.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, findWatchCompany, isoDate, itemId, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
});

export class RssSource implements SourceAdapter {
  readonly descriptor;

  constructor(
    private readonly config: RssSourceConfig,
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {
    this.descriptor = {
      id: config.id,
      name: config.name,
      type: config.sourceType,
      tier: config.tier,
    } as const;
  }

  async fetch(_cursor: string | null): Promise<SourceFetchResult> {
    const response = await fetchWithTimeout(this.config.url, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        "User-Agent": "BiotechSignal/0.1 RSS reader",
      },
    }, this.timeoutMs);
    const xml = await response.text();
    const parsed = parser.parse(xml) as Record<string, unknown>;
    const entries = extractEntries(parsed);
    const discoveredAt = new Date().toISOString();
    const items = entries.flatMap((entry): NormalizedItem[] => {
      const headline = asText(entry.title).trim();
      const link = extractLink(entry.link) || asText(entry.guid);
      if (!headline || !link) return [];
      const url = canonicalUrl(link);
      const externalId = asText(entry.guid) || asText(entry.id) || url;
      const summary = stripHtml(
        asText(entry["content:encoded"]) || asText(entry.content) || asText(entry.description) || asText(entry.summary),
      ).slice(0, 12_000);
      const company = findWatchCompany(`${headline} ${summary}`, this.watchlist);
      return [{
        id: itemId(this.descriptor.id, externalId, url, headline),
        externalId,
        source: this.descriptor,
        headline: stripHtml(headline),
        summary,
        url,
        author: nullableText(entry.author) ?? nullableText(entry["dc:creator"]),
        publishedAt: isoDate(entry.pubDate ?? entry.published ?? entry.updated, new Date()),
        discoveredAt,
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? null,
        raw: entry,
      }];
    });
    return { items, diagnostics: { entryCount: entries.length } };
  }
}

function extractEntries(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const rss = asRecord(parsed.rss);
  const channel = asRecord(rss.channel);
  const feed = asRecord(parsed.feed);
  const raw = channel.item ?? feed.entry ?? parsed.item ?? [];
  return asArray(raw).map(asRecord).filter((value) => Object.keys(value).length > 0);
}

function extractLink(value: unknown): string {
  if (typeof value === "string") return value;
  for (const link of asArray(value)) {
    if (typeof link === "string") return link;
    const record = asRecord(link);
    if (!record["@_rel"] || record["@_rel"] === "alternate") {
      const href = asText(record["@_href"]);
      if (href) return href;
    }
    const text = asText(record);
    if (text) return text;
  }
  return "";
}

function asText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(asText).find(Boolean) ?? "";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = asText(record["#text"] ?? record["@_href"] ?? "");
    if (direct) return direct;
    for (const [key, nested] of Object.entries(record)) {
      if (key.startsWith("@_")) continue;
      const text = asText(nested);
      if (text) return text;
    }
  }
  return "";
}

function nullableText(value: unknown): string | null {
  const text = asText(value).trim();
  return text || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}
