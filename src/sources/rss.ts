import { XMLParser } from "fast-xml-parser";
import type { RssSourceConfig } from "../config.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, isoDate, itemId, resolveWatchCompany, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
});

const RSS_CURSOR_VERSION = 1;
const RSS_CURSOR_ITEM_LIMIT = 200;

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

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
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
    const normalizedItems = entries.flatMap((entry): NormalizedItem[] => {
      const headline = asText(entry.title).trim();
      const link = extractLink(entry.link) || asText(entry.guid);
      if (!headline || !link) return [];
      const url = canonicalUrl(link);
      const externalId = asText(entry.guid) || asText(entry.id) || url;
      const summary = stripHtml(
        asText(entry["content:encoded"]) || asText(entry.content) || asText(entry.description) || asText(entry.summary),
      ).slice(0, 12_000);
      const company = resolveWatchCompany({ headline, summary }, this.watchlist);
      const wireRelease = /(?:globe ?newswire|accesswire|pr ?newswire|business ?wire|newsfile)/i.test(
        `${this.descriptor.name} ${nullableText(entry.author) ?? ""} ${url}`,
      );
      const provenance = this.descriptor.type === "regulator" || this.descriptor.type === "company_ir"
        ? "direct_primary"
        : wireRelease ? "syndicated_primary" : "independent_reporting";
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
        provenance,
        independenceKey: provenance === "direct_primary" && this.descriptor.type === "company_ir" && company
          ? `issuer:${company.ticker.toLowerCase()}`
          : provenance === "syndicated_primary" && company
            ? `issuer:${company.ticker.toLowerCase()}`
            : provenance === "direct_primary"
              ? `authority:${this.descriptor.id}`
              : publisherKey(url, this.descriptor.id),
        raw: entry,
      }];
    });
    const previousIds = parseCursor(cursor);
    const seen = new Set(previousIds);
    const items = normalizedItems.filter((item) => !seen.has(item.id));
    const nextIds = [...new Set([...normalizedItems.map((item) => item.id), ...previousIds])]
      .slice(0, RSS_CURSOR_ITEM_LIMIT);
    return {
      items,
      ...(nextIds.length ? { cursor: JSON.stringify({ version: RSS_CURSOR_VERSION, itemIds: nextIds }) } : {}),
      diagnostics: { entryCount: entries.length, newEntryCount: items.length },
    };
  }
}

function parseCursor(cursor: string | null): string[] {
  if (!cursor) return [];
  try {
    const parsed = JSON.parse(cursor) as { version?: unknown; itemIds?: unknown };
    if (parsed.version !== RSS_CURSOR_VERSION || !Array.isArray(parsed.itemIds)) return [];
    return parsed.itemIds.filter((value): value is string => typeof value === "string")
      .slice(0, RSS_CURSOR_ITEM_LIMIT);
  } catch {
    return [];
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

function publisherKey(url: string, fallback: string): string {
  try {
    return `publisher:${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return `publisher:${fallback}`;
  }
}
