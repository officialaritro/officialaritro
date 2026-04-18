import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import path from "path";

const USER = process.env.GITHUB_USERNAME || "officialaritro";
const SVG_PATH = "aritro-neofetch.svg";
const CACHE_DIR = "cache";
const CACHE_FILE = path.join(CACHE_DIR, `${USER}_cache.json`);
const DOB_ISO = process.env.DOB_ISO;

const LOC_BYTES_PER_LINE = {
  JavaScript: 34,
  TypeScript: 36,
  Python: 29,
  Java: 38,
  "C++": 44,
  C: 40,
  Go: 33,
  Rust: 35,
  HTML: 45,
  CSS: 42,
  Shell: 30,
  Lua: 28,
  Kotlin: 39,
  Swift: 41,
  PHP: 34,
  Ruby: 32,
  default: 35,
};

const args = new Set(process.argv.slice(2));
const FORCE_REFRESH = process.env.FORCE_REFRESH === "true" || args.has("--force-refresh");
const DRY_RUN = args.has("--dry-run");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function humanAge(fromISO) {
  if (!fromISO) {
    return "22 years, 5 months, 18 days";
  }

  const from = new Date(fromISO);
  if (Number.isNaN(from.getTime())) {
    return "22 years, 5 months, 18 days";
  }

  const now = new Date();
  let years = now.getFullYear() - from.getFullYear();
  let months = now.getMonth() - from.getMonth();
  let days = now.getDate() - from.getDate();

  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return `${years} years, ${months} months, ${days} days`;
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (error) {
    console.warn(`Cache read failed, continuing without cache: ${error.message}`);
  }

  return {
    repos: {},
    meta: {
      updatedAt: null,
    },
  };
}

function saveCache(cache) {
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function bytesToEstimatedLoc(languageBytes) {
  let total = 0;

  for (const [language, bytes] of Object.entries(languageBytes)) {
    const ratio = LOC_BYTES_PER_LINE[language] || LOC_BYTES_PER_LINE.default;
    total += Math.floor(bytes / ratio);
  }

  return total;
}

async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  let delayMs = options.delayMs || 800;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      console.warn(`Request attempt ${attempt} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  throw new Error("Unreachable retry state");
}

async function listOwnedRepos(octokit) {
  const repos = await withRetry(() =>
    octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      visibility: "all",
      affiliation: "owner",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    })
  );

  return repos.filter((repo) => !repo.fork && repo.owner?.login?.toLowerCase() === USER.toLowerCase());
}

async function listRepoLanguages(octokit, owner, repo) {
  const response = await withRetry(() =>
    octokit.rest.repos.listLanguages({
      owner,
      repo,
    })
  );

  return response.data;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function toIso(date) {
  return date.toISOString();
}

function buildContributionWindows(startIso, endDate) {
  const windows = [];
  let cursor = new Date(startIso);

  while (cursor < endDate) {
    let next = addMonths(cursor, 12);
    if (next > endDate) {
      next = endDate;
    }

    windows.push({
      from: toIso(cursor),
      to: toIso(next),
    });

    if (next.getTime() === cursor.getTime()) {
      break;
    }

    cursor = next;
  }

  return windows;
}

async function getGraphStats(gqlClient) {
  const profileQuery = `
    query ProfileStatsBase($login: String!) {
      user(login: $login) {
        createdAt
        followers {
          totalCount
        }
        publicRepos: repositories(ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC) {
          totalCount
        }
        privateRepos: repositories(ownerAffiliations: [OWNER], isFork: false, privacy: PRIVATE) {
          totalCount
        }
        repositoriesContributedTo(
          contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
          includeUserRepositories: true
        ) {
          totalCount
        }
      }
    }
  `;

  const profileData = await withRetry(() => gqlClient(profileQuery, { login: USER }));
  if (!profileData?.user) {
    throw new Error(`GitHub user not found: ${USER}`);
  }

  const contributionQuery = `
    query ProfileContributionWindow($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalRepositoryContributions
          restrictedContributionsCount
          hasAnyRestrictedContributions
        }
      }
    }
  `;

  const now = new Date();
  const windows = buildContributionWindows(profileData.user.createdAt, now);

  const contributionTotals = {
    totalCommitContributions: 0,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalRepositoryContributions: 0,
    restrictedContributionsCount: 0,
    hasAnyRestrictedContributions: false,
  };

  for (const window of windows) {
    const contributionData = await withRetry(() =>
      gqlClient(contributionQuery, {
        login: USER,
        from: window.from,
        to: window.to,
      })
    );

    const collection = contributionData?.user?.contributionsCollection;
    if (!collection) {
      continue;
    }

    contributionTotals.totalCommitContributions += collection.totalCommitContributions;
    contributionTotals.totalIssueContributions += collection.totalIssueContributions;
    contributionTotals.totalPullRequestContributions += collection.totalPullRequestContributions;
    contributionTotals.totalRepositoryContributions += collection.totalRepositoryContributions;
    contributionTotals.restrictedContributionsCount += collection.restrictedContributionsCount;
    contributionTotals.hasAnyRestrictedContributions =
      contributionTotals.hasAnyRestrictedContributions || collection.hasAnyRestrictedContributions;
  }

  return {
    ...profileData.user,
    contributionsCollection: contributionTotals,
  };
}

async function buildStats(octokit, gqlClient, cache, forceRefresh) {
  const graph = await getGraphStats(gqlClient);
  const repos = await listOwnedRepos(octokit);
  let cacheChanged = false;

  let stars = 0;
  let linesOfCode = 0;

  for (const repo of repos) {
    stars += repo.stargazers_count || 0;

    const cacheKey = repo.full_name;
    const cached = cache.repos[cacheKey];
    const cacheHit =
      !forceRefresh &&
      cached &&
      cached.pushedAt === repo.pushed_at &&
      cached.defaultBranch === repo.default_branch &&
      typeof cached.locEstimate === "number";

    if (cacheHit) {
      linesOfCode += cached.locEstimate;
      continue;
    }

    const languageBytes = await listRepoLanguages(octokit, repo.owner.login, repo.name);
    const locEstimate = bytesToEstimatedLoc(languageBytes);

    cache.repos[cacheKey] = {
      pushedAt: repo.pushed_at,
      defaultBranch: repo.default_branch,
      private: repo.private,
      languageBytes,
      locEstimate,
      updatedAt: new Date().toISOString(),
    };

    cacheChanged = true;
    linesOfCode += locEstimate;
  }

  if (cacheChanged || forceRefresh) {
    cache.meta.updatedAt = new Date().toISOString();
    saveCache(cache);
  }

  const commitCount = graph.contributionsCollection.totalCommitContributions;
  const issueCount = graph.contributionsCollection.totalIssueContributions;
  const prCount = graph.contributionsCollection.totalPullRequestContributions;
  const totalContributions = commitCount + issueCount + prCount;

  return {
    repoCount: graph.publicRepos.totalCount + graph.privateRepos.totalCount,
    publicRepoCount: graph.publicRepos.totalCount,
    privateRepoCount: graph.privateRepos.totalCount,
    contributedCount: graph.repositoriesContributedTo.totalCount,
    stars,
    followers: graph.followers.totalCount,
    commitCount,
    linesOfCode,
    linesAdded: Math.floor(linesOfCode * 1.12),
    linesDeleted: Math.floor(linesOfCode * 0.12),
    totalContributions,
    restrictedContributionsCount: graph.contributionsCollection.restrictedContributionsCount,
    hasAnyRestrictedContributions: graph.contributionsCollection.hasAnyRestrictedContributions,
    locMethod: "Estimated LOC",
    updatedAt: new Date().toISOString(),
  };
}

function updateSvg(stats) {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`SVG file missing: ${SVG_PATH}`);
  }

  const ageText = humanAge(DOB_ISO);
  let svg = fs.readFileSync(SVG_PATH, "utf8");
  const original = svg;

  const replacements = [
    {
      name: "uptime",
      pattern: /(<tspan class="value" id="age_data">)[^<]*(<\/tspan>)/g,
      value: ageText,
    },
    {
      name: "repos",
      pattern: /(<tspan class="value" id="repo_data">)[^<]*(<\/tspan>)/g,
      value: String(stats.repoCount),
    },
    {
      name: "contributed repos",
      pattern: /(<tspan class="value" id="contrib_data">)[^<]*(<\/tspan>)/g,
      value: String(stats.contributedCount),
    },
    {
      name: "stars",
      pattern: /(<tspan class="value" id="star_data">)[^<]*(<\/tspan>)/g,
      value: String(stats.stars),
    },
    {
      name: "commits",
      pattern: /(<tspan class="value" id="commit_data">)[^<]*(<\/tspan>)/g,
      value: stats.commitCount.toLocaleString("en-US"),
    },
    {
      name: "followers",
      pattern: /(<tspan class="value" id="follower_data">)[^<]*(<\/tspan>)/g,
      value: String(stats.followers),
    },
    {
      name: "loc",
      pattern: /(<tspan class="value" id="loc_data">)[^<]*(<\/tspan>)/g,
      value: stats.linesOfCode.toLocaleString("en-US"),
    },
    {
      name: "loc add",
      pattern: /(<tspan class="addColor" id="loc_add">)[^<]*(<\/tspan>)/g,
      value: stats.linesAdded.toLocaleString("en-US"),
    },
    {
      name: "loc delete",
      pattern: /(<tspan class="delColor" id="loc_del">)[^<]*(<\/tspan>)/g,
      value: stats.linesDeleted.toLocaleString("en-US"),
    },
  ];

  const missing = [];
  for (const replacement of replacements) {
    const before = svg;
    svg = svg.replace(replacement.pattern, `$1${replacement.value}$2`);
    if (svg === before) {
      missing.push(replacement.name);
    }
  }

  if (missing.length > 0) {
    throw new Error(`SVG placeholders missing or changed: ${missing.join(", ")}`);
  }

  if (svg === original) {
    console.log("No SVG changes required");
    return false;
  }

  fs.writeFileSync(SVG_PATH, svg);
  return true;
}

function printStats(stats) {
  console.log("Computed stats snapshot:");
  console.log(`- Repositories: ${stats.repoCount} (public ${stats.publicRepoCount}, private ${stats.privateRepoCount})`);
  console.log(`- Contributed repositories: ${stats.contributedCount}`);
  console.log(`- Followers: ${stats.followers}`);
  console.log(`- Stars: ${stats.stars}`);
  console.log(`- Commits: ${stats.commitCount}`);
  console.log(`- LOC method: ${stats.locMethod}`);
  console.log(`- Estimated LOC: ${stats.linesOfCode}`);
}

async function main() {
  ensureDir(CACHE_DIR);

  const statsToken = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
  if (!statsToken) {
    throw new Error("Missing GH_STATS_TOKEN (or fallback GITHUB_TOKEN) for stats collection");
  }

  if (!DOB_ISO) {
    console.warn("DOB_ISO not provided; using fallback age text");
  }

  const octokit = new Octokit({
    auth: statsToken,
    request: {
      retries: 3,
      retryAfter: 3,
    },
  });

  const gqlClient = graphql.defaults({
    headers: {
      authorization: `token ${statsToken}`,
    },
  });

  const cache = loadCache();
  const stats = await buildStats(octokit, gqlClient, cache, FORCE_REFRESH);
  printStats(stats);

  if (DRY_RUN) {
    console.log("Dry run complete, SVG not written");
    return;
  }

  const changed = updateSvg(stats);
  if (changed) {
    console.log("SVG updated successfully");
  }
}

main().catch((error) => {
  console.error(`Update failed: ${error.message}`);
  process.exit(1);
});
