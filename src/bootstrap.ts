import { HeuristicDemoAnalyzer } from "./analysis/heuristic-analyzer.js";
import { OpenAICatalystAnalyzer } from "./analysis/openai-analyzer.js";
import { AlertService } from "./alerts/service.js";
import { loadConfig } from "./config.js";
import { createClubAttendanceSheetSync } from "./club-sheets.js";
import { SignalDatabase } from "./db.js";
import { AlpacaMarketDataService } from "./market-data/alpaca.js";
import { OutcomeAuditor } from "./outcomes.js";
import { MonitorPipeline, type PipelineLogger } from "./pipeline.js";
import { createSources } from "./sources/index.js";

export function bootstrap(logger: PipelineLogger) {
  const config = loadConfig();
  const db = new SignalDatabase(config.databasePath, config.club.dataKey);
  for (const learned of db.listCompanyPrograms()) {
    const company = config.watchlist.find((candidate) => candidate.ticker === learned.ticker);
    if (company && !company.programs.some((program) => program.toLowerCase() === learned.program.toLowerCase())) {
      company.programs.push(learned.program);
    }
  }
  const sources = createSources(config);
  db.syncSourceDescriptors(sources.map((source) => source.descriptor));
  const analyzer = config.openaiApiKey
    ? new OpenAICatalystAnalyzer(config.openaiApiKey, config.openaiModel)
    : new HeuristicDemoAnalyzer();
  const alerts = new AlertService(config, db);
  const marketData = new AlpacaMarketDataService(config.alpaca, {
    timeoutMs: Math.min(config.sourceTimeoutMs, 8_000),
    onError: (error) => logger.warn({ error }, "Alpaca market data request failed"),
  });
  const outcomes = new OutcomeAuditor(
    db,
    marketData,
    logger,
    config.outcomes.intervalMinutes,
    config.outcomes.batchSize,
  );
  const clubSheets = createClubAttendanceSheetSync(config.club.sheets, db, logger);
  const pipeline = new MonitorPipeline(config, db, sources, analyzer, alerts, logger, outcomes);
  return { config, db, sources, analyzer, alerts, marketData, outcomes, clubSheets, pipeline };
}
