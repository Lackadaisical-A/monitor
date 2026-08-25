import type { AppConfig } from "../config.js";
import type { SourceAdapter } from "../types.js";
import { ClinicalTrialsSource } from "./clinical-trials.js";
import { RedditSource } from "./reddit.js";
import { RssSource } from "./rss.js";
import { SecFilingsSource } from "./sec.js";
import { FdaAdvisorySource } from "./federal-register.js";
import { XRecentSearchSource } from "./x.js";
import { QuoteMediaPressReleaseSource } from "./quote-media.js";
import { AlpacaNewsSource } from "./alpaca-news.js";

export function createSources(config: AppConfig): SourceAdapter[] {
  const sources: SourceAdapter[] = config.rssSources.map((source) => new RssSource(source, config.watchlist, config.sourceTimeoutMs));
  sources.push(...config.quoteMediaSources.map(
    (source) => new QuoteMediaPressReleaseSource(source, config.watchlist, config.sourceTimeoutMs),
  ));
  if (config.alpaca.newsEnabled && config.alpaca.keyId && config.alpaca.secretKey) {
    sources.push(new AlpacaNewsSource(config.alpaca, config.watchlist, config.sourceTimeoutMs));
  }
  if (config.x.bearerToken) {
    sources.push(new XRecentSearchSource(config.x.bearerToken, config.x.query, config.watchlist, config.sourceTimeoutMs));
  }
  if (config.reddit.clientId && config.reddit.clientSecret) {
    sources.push(new RedditSource(config.reddit, config.watchlist, config.sourceTimeoutMs));
  }
  if (config.clinicalTrialsEnabled && config.watchlist.length > 0) {
    sources.push(new ClinicalTrialsSource(config.watchlist, config.sourceTimeoutMs));
  }
  if (config.secEnabled && config.watchlist.some((company) => company.cik)) {
    sources.push(new SecFilingsSource(config.watchlist, config.secUserAgent, config.sourceTimeoutMs));
  }
  if (config.fdaAdcomEnabled) {
    sources.push(new FdaAdvisorySource(config.watchlist, config.sourceTimeoutMs));
  }
  return sources;
}
