import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const IBB_HOLDINGS_URL = "https://www.ishares.com/us/products/239699/ishares-biotechnology-etf/latest-holdings.csv";
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const OUTPUT_PATH = resolve("config/watchlist.json");

const STRATEGIC_ADDITIONS = [
  { ticker: "ABBV", company: "AbbVie", marketCapBand: "mega" },
  { ticker: "AZN", company: "AstraZeneca", marketCapBand: "mega" },
  { ticker: "BAYRY", company: "Bayer", marketCapBand: "large" },
  { ticker: "BMY", company: "Bristol Myers Squibb", marketCapBand: "mega" },
  { ticker: "GSK", company: "GSK", marketCapBand: "mega" },
  { ticker: "JNJ", company: "Johnson & Johnson", marketCapBand: "mega" },
  { ticker: "LLY", company: "Eli Lilly", marketCapBand: "mega" },
  { ticker: "MRK", company: "Merck", marketCapBand: "mega", programs: ["KEYTRUDA", "pembrolizumab"] },
  { ticker: "NVO", company: "Novo Nordisk", marketCapBand: "mega" },
  { ticker: "NVS", company: "Novartis", marketCapBand: "mega" },
  { ticker: "PFE", company: "Pfizer", marketCapBand: "mega" },
  { ticker: "RHHBY", company: "Roche", marketCapBand: "mega" },
  { ticker: "SNY", company: "Sanofi", marketCapBand: "mega" },
  { ticker: "TAK", company: "Takeda Pharmaceutical", marketCapBand: "large" },
  { ticker: "TEVA", company: "Teva Pharmaceutical", marketCapBand: "large" },
  { ticker: "ZTS", company: "Zoetis", marketCapBand: "large" },
];

const OVERRIDES = {
  ABBV: { company: "AbbVie", marketCapBand: "mega" },
  AMGN: { company: "Amgen", marketCapBand: "mega" },
  GILD: { company: "Gilead Sciences", marketCapBand: "mega" },
  MRNA: {
    company: "Moderna",
    aliases: ["Moderna, Inc.", "ModernaTX", "$MRNA"],
    marketCapBand: "large",
    xAccounts: ["moderna_tx"],
    programs: [
      "intismeran autogene", "V940", "mRNA-4157", "mRNA-1010", "mRNA-1083",
      "mRNA-1283", "mRNA-1345", "mRNA-1403", "mRNA-1469", "mRNA-1647",
      "mRNA-3705", "mRNA-3927", "mFLUSIVA", "mRESVIA", "Spikevax",
    ],
  },
  CRSP: {
    company: "CRISPR Therapeutics",
    aliases: ["CRISPR Therapeutics AG", "$CRSP"],
    programs: ["CASGEVY", "CTX112", "CTX131", "CTX310", "CTX320"],
  },
  VRTX: { company: "Vertex Pharmaceuticals", marketCapBand: "large", programs: ["CASGEVY", "Alyftrek", "Journavx"] },
  BNTX: { company: "BioNTech", aliases: ["BioNTech SE", "$BNTX"], programs: ["BNT122", "autogene cevumeran"] },
};

const [holdingsCsv, secJson] = await Promise.all([
  fetchText(IBB_HOLDINGS_URL, "CatalystWatch/0.1 watchlist refresh"),
  fetchText(SEC_TICKERS_URL, "CatalystWatch/0.1 you@example.com"),
]);
const secPayload = JSON.parse(secJson);
const secByTicker = new Map(
  Object.values(secPayload).map((entry) => [String(entry.ticker).toUpperCase(), entry]),
);
const rows = parseCsv(holdingsCsv);
const headerIndex = rows.findIndex((row) => row[0] === "Ticker" && row.includes("Asset Class"));
if (headerIndex < 0) throw new Error("IBB holdings CSV did not contain the expected header");
const headers = rows[headerIndex];
const records = rows.slice(headerIndex + 1)
  .filter((row) => row.length >= headers.length)
  .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])))
  .filter((row) => row["Asset Class"] === "Equity" && /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(row.Ticker));

const candidates = [
  ...records.map((row) => ({ ticker: row.Ticker, company: row.Name, marketCapBand: "unknown", fundWeight: Number(row["Weight (%)"]) || 0 })),
  ...STRATEGIC_ADDITIONS.map((entry) => ({ ...entry, fundWeight: 0 })),
];
const deduped = new Map();
for (const candidate of candidates) {
  const ticker = candidate.ticker.toUpperCase();
  if (!deduped.has(ticker)) deduped.set(ticker, candidate);
}

const watchlist = [...deduped.values()].map((candidate) => {
  const ticker = candidate.ticker.toUpperCase();
  const sec = secByTicker.get(ticker);
  const override = OVERRIDES[ticker] ?? {};
  const rawCompany = candidate.company || sec?.title || ticker;
  const company = override.company ?? titleCase(rawCompany);
  const aliases = unique([
    `$${ticker}`,
    rawCompany,
    sec?.title,
    simplifiedName(rawCompany),
    ...(candidate.aliases ?? []),
    ...(override.aliases ?? []),
  ]).filter((alias) => alias.toLowerCase() !== company.toLowerCase());
  return {
    ticker,
    company,
    aliases,
    ...(sec?.cik_str ? { cik: String(sec.cik_str).padStart(10, "0") } : {}),
    marketCapBand: override.marketCapBand ?? candidate.marketCapBand ?? "unknown",
    xAccounts: unique([...(candidate.xAccounts ?? []), ...(override.xAccounts ?? [])]),
    programs: unique([...(candidate.programs ?? []), ...(override.programs ?? [])]),
    fundWeight: candidate.fundWeight,
  };
}).sort((left, right) => {
  if (left.ticker === "MRNA") return -1;
  if (right.ticker === "MRNA") return 1;
  return right.fundWeight - left.fundWeight || left.ticker.localeCompare(right.ticker);
}).map(({ fundWeight: _fundWeight, ...entry }) => entry);

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(watchlist, null, 2)}\n`, "utf8");
const cikCount = watchlist.filter((entry) => entry.cik).length;
console.log(`Wrote ${watchlist.length} companies (${cikCount} with SEC CIKs) to ${OUTPUT_PATH}`);

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function titleCase(value) {
  return value.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bAdr\b/g, "ADR")
    .replace(/\bAg\b/g, "AG")
    .replace(/\bNv\b/g, "NV")
    .replace(/\bPlc\b/g, "plc")
    .replace(/\bSe\b/g, "SE");
}

function simplifiedName(value) {
  return titleCase(value)
    .replace(/\s+(?:American Depositary Shares?|Sponsored ADR|ADR|Class [A-Z])$/i, "")
    .replace(/\s+(?:Holdings?|Therapeutics?|Pharmaceuticals?|Sciences?)?\s*(?:Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|plc|SE|SA|AG|NV)$/i, "")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

async function fetchText(url, userAgent) {
  const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "*/*" } });
  if (response.ok) return response.text();
  const run = promisify(execFile);
  const { stdout } = await run("curl", ["-L", "--fail", "--silent", "--show-error", "--user-agent", userAgent, url], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}
