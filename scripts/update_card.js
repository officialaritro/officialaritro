// scripts/update_card.js
// Requires: npm i @octokit/rest jsdom @octokit/graphql

import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import { JSDOM } from "jsdom";
import { execSync } from "child_process";
import path from "path";
import os from "os";

const USER = "officialaritro";
const SVG_PATH = "neofetch-card.svg";
const WORKDIR = path.join(os.tmpdir(), "repos");
const DOB = process.env.DOB_ISO;

function humanAge(fromISO) {
  if (!fromISO) return "—";
  const from = new Date(fromISO);
  const now = new Date();
  let years = now.getFullYear() - from.getFullYear();
  let months = now.getMonth() - from.getMonth();
  let days = now.getDate() - from.getDate();
  if (days < 0) { months--; days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (months < 0) { years--; months += 12; }
  return `${years} years, ${months} months, ${days} days`;
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const gql = graphql.defaults({ headers: { authorization: `token ${process.env.GITHUB_TOKEN}` } });

async function getStats() {
  const { data: user } = await octokit.rest.users.getByUsername({ username: USER });

  const repos = await octokit.paginate(octokit.rest.repos.listForUser, { username: USER, per_page: 100 });
  const publicRepos = repos.filter(r => !r.fork);
  const repoCount = publicRepos.length;
  const stars = publicRepos.reduce((a, r) => a + (r.stargazers_count || 0), 0);
  const followers = user.followers ?? 0;

  const { user: contribs } = await gql(`
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
        }
      }
    }
  `, { login: USER });
  const commitCount = contribs.contributionsCollection.totalCommitContributions;

  // LOC calculation (all-time)
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(WORKDIR, { recursive: true });
  let added = 0, deleted = 0;

  for (const repo of publicRepos) {
    try {
      const repoPath = path.join(WORKDIR, repo.name);
      console.log(`Cloning ${repo.full_name} ...`);
      execSync(`git clone --quiet --depth=1 https://github.com/${repo.full_name}.git "${repoPath}"`);
      const output = execSync(`git log --pretty=tformat: --numstat`, { cwd: repoPath }).toString();
      output.split("\n").forEach(line => {
        const parts = line.trim().split("\t");
        if (parts.length === 3) {
          const a = parseInt(parts[0]);
          const d = parseInt(parts[1]);
          if (!isNaN(a)) added += a;
          if (!isNaN(d)) deleted += d;
        }
      });
    } catch (err) {
      console.error(`❌ Error in ${repo.name}:`, err.message);
    }
  }

  return { repoCount, stars, followers, commitCount, added, deleted };
}

function updateSVG({ repoCount, stars, followers, commitCount, added, deleted }) {
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  const doc = dom.window.document;

  const setText = (id, val) => {
    const el = doc.getElementById(id);
    if (el) el.textContent = String(val);
  };

  setText("repo_data", repoCount);
  setText("star_data", stars);
  setText("follower_data", followers);
  setText("commit_data", commitCount);
  setText("age_data", humanAge(DOB));
  setText("loc_data", (added + deleted).toLocaleString());
  setText("loc_add", added.toLocaleString());
  setText("loc_del", deleted.toLocaleString());

  fs.writeFileSync(SVG_PATH, dom.serialize());
  console.log("✔ SVG updated with stats");
}

getStats().then(updateSVG).catch(err => {
  console.error("❌ Error updating card:", err);
  process.exit(1);
});
