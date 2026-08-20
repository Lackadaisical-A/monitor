import { HeuristicDemoAnalyzer } from "./analysis/heuristic-analyzer.js";
import { OpenAICatalystAnalyzer } from "./analysis/openai-analyzer.js";
import { AlertService } from "./alerts/service.js";
import { loadConfig } from "./config.js";
import { SignalDatabase } from "./db.js";
import { MonitorPipeline, type PipelineLogger } from "./pipeline.js";
import { createSources } from "./sources/index.js";

export function bootstrap(logger: PipelineLogger) {
  const config = loadConfig();
  const db = new SignalDatabase(config.databasePath);
  const sources = createSources(config);
  const analyzer = config.openaiApiKey
    ? new OpenAICatalystAnalyzer(config.openaiApiKey, config.openaiModel)
    : new HeuristicDemoAnalyzer();
  const alerts = new AlertService(config, db);
  const pipeline = new MonitorPipeline(config, db, sources, analyzer, alerts, logger);
  return { config, db, sources, analyzer, alerts, pipeline };
}
