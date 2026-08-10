#!/usr/bin/env node
/**
 * job-agent CLI.
 *
 * Dry run is the default: the agent fills the form and stops so you can look at
 * the screenshot. Nothing is ever submitted without --submit.
 */

import { readFileSync } from "node:fs";

import { applyToJob } from "./apply.js";
import { loadProfile, validateProfile } from "./profile.js";
import { buildCoverLetter } from "./cover-letter.js";
import { readEntries } from "./log.js";
import { llmAvailable } from "./llm.js";

const USAGE = `
job-agent — fill out and submit job applications from your profile

Usage:
  job-agent apply <url> [options]        Apply to one posting
  job-agent queue <jobs.json> [options]  Work through a list of postings
  job-agent letter [options]             Print the cover letter for a job
  job-agent log [options]                Show what you've applied to
  job-agent check [options]              Validate your profile

Options:
  --profile <path>   Profile JSON (default: ./profile.json)
  --submit           Actually submit. Without it, the agent fills and stops.
  --ai               Use Claude to tailor the cover letter and freeform answers
  --headed           Show the browser window
  --company <name>   Override the company name
  --role <title>     Override the role title
  --out <dir>        Where screenshots and drafts go (default: ./runs)
  --log <path>       Application log (default: ./applications.jsonl)
  --force            Apply again to a posting already in the log; submit despite warnings
  --limit <n>        queue: stop after n applications
  --delay <seconds>  queue: wait between applications (default: 20)
  -h, --help         Show this message

Examples:
  job-agent apply https://boards.greenhouse.io/acme/jobs/123
  job-agent apply https://jobs.lever.co/acme/abc --ai --submit
  job-agent queue jobs.json --limit 5
`.trim();

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (arg === "-h") options.help = true;
      else options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["submit", "headed", "ai", "force", "help"].includes(key)) options[key] = true;
    else options[key] = argv[++i];
  }
  return options;
}

function runOptions(options) {
  return {
    submit: Boolean(options.submit),
    headless: !options.headed,
    outDir: options.out || "runs",
    logPath: options.log || "applications.jsonl",
    useLLM: Boolean(options.ai),
    force: Boolean(options.force)
  };
}

function warnIfSubmitting(options) {
  if (!options.submit) return;
  console.log("--submit is set: applications will be sent for real.\n");
}

function checkLLM(options) {
  if (options.ai && !llmAvailable()) {
    console.log("--ai requested but no Anthropic credentials found; falling back to the template cover letter.");
    console.log("Set ANTHROPIC_API_KEY (or run `ant auth login`) to enable it.\n");
  }
}

async function commandApply(options) {
  const url = options._[1];
  if (!url) throw new Error("usage: job-agent apply <url>");
  const profile = loadProfile(options.profile || "profile.json");
  warnIfSubmitting(options);
  checkLLM(options);

  const report = await applyToJob(
    { url, company: options.company, role: options.role },
    profile,
    runOptions(options)
  );
  console.log(`\nStatus: ${report.status}`);
  if (report.runDir) console.log(`Artifacts: ${report.runDir}`);
  process.exitCode = report.status === "failed" ? 1 : 0;
}

async function commandQueue(options) {
  const path = options._[1];
  if (!path) throw new Error("usage: job-agent queue <jobs.json>");
  const profile = loadProfile(options.profile || "profile.json");

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
  if (!Array.isArray(jobs)) throw new Error(`${path} must be a JSON array of jobs, or { "jobs": [...] }`);

  const limit = options.limit ? Number(options.limit) : jobs.length;
  const delay = (options.delay ? Number(options.delay) : 20) * 1000;
  warnIfSubmitting(options);
  checkLLM(options);

  const results = [];
  for (const [index, job] of jobs.slice(0, limit).entries()) {
    console.log(`\n=== [${index + 1}/${Math.min(limit, jobs.length)}] ${job.url} ===`);
    try {
      results.push(await applyToJob(job, profile, runOptions(options)));
    } catch (error) {
      console.log(`Error: ${error.message}`);
      results.push({ url: job.url, status: "failed", error: error.message });
    }
    if (index < Math.min(limit, jobs.length) - 1 && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.log("\n=== Summary ===");
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  for (const [status, count] of Object.entries(counts)) console.log(`  ${status}: ${count}`);
  for (const result of results) {
    console.log(`  ${result.status.padEnd(11)} ${result.url}`);
  }
}

async function commandLetter(options) {
  const profile = loadProfile(options.profile || "profile.json");
  const letter = buildCoverLetter(profile, { company: options.company, role: options.role });
  if (letter.missing.length > 0) {
    console.log(`(unfilled template placeholders: ${letter.missing.join(", ")})\n`);
  }
  console.log(letter.text);
}

function commandLog(options) {
  const entries = readEntries(options.log || "applications.jsonl");
  if (entries.length === 0) {
    console.log("No applications logged yet.");
    return;
  }
  for (const entry of entries) {
    const when = entry.timestamp?.slice(0, 16).replace("T", " ") || "";
    console.log(`${when}  ${String(entry.status).padEnd(11)} ${entry.role || "?"} @ ${entry.company || "?"}`);
    console.log(`                   ${entry.url}`);
  }
  console.log(`\n${entries.length} application(s) logged.`);
}

function commandCheck(options) {
  const path = options.profile || "profile.json";
  const profile = loadProfile(path);
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    console.log(`Profile has problems:\n  - ${errors.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Profile OK: ${path}`);
  console.log(`  Name:   ${profile.personal.firstName} ${profile.personal.lastName}`);
  console.log(`  Email:  ${profile.personal.email}`);
  console.log(`  Resume: ${profile.documents?.resume || "(none — file uploads will be skipped)"}`);
  console.log(`  Highlights: ${(profile.highlights || []).length}`);
  console.log(`  Claude tailoring: ${llmAvailable() ? "available" : "unavailable (set ANTHROPIC_API_KEY to enable --ai)"}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];

  if (options.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "apply": return commandApply(options);
    case "queue": return commandQueue(options);
    case "letter": return commandLetter(options);
    case "log": return commandLog(options);
    case "check": return commandCheck(options);
    default:
      console.log(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`${error.message}`);
  process.exitCode = 1;
});
