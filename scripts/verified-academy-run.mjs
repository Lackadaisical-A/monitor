// Resume a distribution attempt only when GitHub confirms the earlier tests
// passed and every app/server/test/dependency input is byte-for-byte unchanged.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const id = process.env.ACADEMY_VERIFIED_RUN;
if (!/^\d+$/.test(id ?? "")) throw new Error("A numeric validation run ID is required");
const repo = process.env.GITHUB_REPOSITORY;
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
async function get(path) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers });
  if (!response.ok) throw new Error(`Validation lookup failed (${response.status})`);
  return response.json();
}
const run = await get(`actions/runs/${id}`);
if (run.repository.full_name !== repo || run.head_branch !== process.env.GITHUB_REF_NAME || run.path !== ".github/workflows/app-store.yml") throw new Error("Validation must come from this branch's release workflow");
const jobs = await get(`actions/runs/${id}/jobs?per_page=100`);
if (!jobs.jobs.some(job => job.steps.some(step => step.name === "Verify Academy build" && step.conclusion === "success"))) throw new Error("The previous Academy checks did not pass");
execFileSync("git", ["diff", "--exit-code", "--quiet", run.head_sha, "HEAD", "--", "ios", "src", "tests", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"]);
appendFileSync(process.env.GITHUB_OUTPUT, "verified=true\n");
console.log(`Reusing passed Academy checks from run ${id}; app, server, tests, and dependencies are unchanged.`);
