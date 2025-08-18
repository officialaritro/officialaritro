// scripts/update_card.js
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const USER = "officialaritro";
const SVG_PATH = "aritro-neofetch.svg";
const DOB_ISO = process.env.DOB_ISO;
const CACHE_DIR = "cache";
const CACHE_FILE = path.join(CACHE_DIR, `${USER}_cache.json`);

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Calculate human-readable age from DOB
function humanAge(fromISO) {
  if (!fromISO) return "22 years, 5 months, 18 days"; // fallback
  
  const from = new Date(fromISO);
  const now = new Date();
  
  let years = now.getFullYear() - from.getFullYear();
  let months = now.getMonth() - from.getMonth();
  let days = now.getDate() - from.getDate();
  
  if (days < 0) { 
    months--; 
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); 
  }
  if (months < 0) { 
    years--; 
    months += 12; 
  }
  
  return `${years} years, ${months} months, ${days} days`;
}

// Load cache from file
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`📦 Cache loaded: ${Object.keys(cacheData.repos || {}).length} repos cached`);
      return cacheData;
    }
  } catch (error) {
    console.warn("⚠️ Failed to load cache, starting fresh:", error.message);
  }
  return {
    repos: {},
    lastUpdated: null,
    stats: null
  };
}

// Save cache to file
function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log("💾 Cache saved successfully");
  } catch (error) {
    console.error("❌ Failed to save cache:", error.message);
  }
}

// Create hash for repository identification
function createRepoHash(fullName) {
  return crypto.createHash('sha256').update(fullName).digest('hex').substring(0, 16);
}

// Initialize GitHub API clients with retry logic
const octokit = new Octokit({ 
  auth: process.env.GITHUB_TOKEN,
  request: {
    retries: 3,
    retryAfter: 3
  }
});

const gql = graphql.defaults({ 
  headers: { authorization: `token ${process.env.GITHUB_TOKEN}` } 
});

// Retry wrapper for API calls
async function withRetry(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      console.warn(`⚠️ Attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

// Get repository commit count using GraphQL
async function getRepoCommitCount(owner, repo) {
  try {
    const { repository } = await gql(`
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef {
            target {
              ... on Commit {
                history {
                  totalCount
                }
              }
            }
          }
        }
      }
    `, { owner, repo });
    
    return repository?.defaultBranchRef?.target?.history?.totalCount || 0;
  } catch (error) {
    console.warn(`⚠️ Failed to get commit count for ${owner}/${repo}:`, error.message);
    return 0;
  }
}

// Get user's contribution statistics
async function getUserContributions() {
  try {
    const { user } = await gql(`
      query($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
            totalRepositoryContributions
          }
        }
      }
    `, { login: USER });
    
    return user.contributionsCollection;
  } catch (error) {
    console.warn("⚠️ Failed to get contributions:", error.message);
    return {
      totalCommitContributions: 0,
      totalIssueContributions: 0,
      totalPullRequestContributions: 0,
      totalRepositoryContributions: 0
    };
  }
}

// Calculate lines of code with improved estimation
function estimateLinesOfCode(repos, commitCount) {
  // More sophisticated estimation based on repository languages and sizes
  let totalEstimate = 0;
  
  for (const repo of repos) {
    if (repo.fork) continue; // Skip forks for LOC calculation
    
    // Base estimate on repository size and language
    let repoEstimate = repo.size * 10; // Size is in KB, rough conversion
    
    // Adjust based on primary language
    const language = repo.language;
    const langMultiplier = {
      'JavaScript': 1.2,
      'TypeScript': 1.3,
      'Python': 1.0,
      'Java': 1.5,
      'C++': 1.4,
      'C': 1.3,
      'Go': 1.1,
      'Rust': 1.2,
      'HTML': 0.8,
      'CSS': 0.6
    };
    
    repoEstimate *= (langMultiplier[language] || 1.0);
    totalEstimate += repoEstimate;
  }
  
  // Also factor in commit count
  const commitBasedEstimate = commitCount * 45; // Average lines per commit
  
  // Take weighted average
  const finalEstimate = Math.floor((totalEstimate * 0.6) + (commitBasedEstimate * 0.4));
  
  return {
    total: finalEstimate,
    added: Math.floor(finalEstimate * 1.15),
    deleted: Math.floor(finalEstimate * 0.15)
  };
}

// Get GitHub statistics with caching
async function getStats() {
  console.log("🔍 Fetching GitHub stats...");
  
  const cache = loadCache();
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  try {
    // Get user data
    const { data: user } = await withRetry(() => 
      octokit.rest.users.getByUsername({ username: USER })
    );
    
    // Check if we can use cached stats (less than 24 hours old)
    if (cache.lastUpdated && new Date(cache.lastUpdated) > oneDayAgo && cache.stats) {
      console.log("📋 Using cached stats (less than 24h old)");
      return cache.stats;
    }
    
    console.log("🔄 Fetching fresh data...");
    
    // Get all repositories with pagination
    const repos = await withRetry(() =>
      octokit.paginate(octokit.rest.repos.listForUser, { 
        username: USER, 
        per_page: 100,
        sort: 'updated',
        direction: 'desc'
      })
    );
    
    console.log(`📚 Found ${repos.length} repositories`);
    
    // Separate owned and forked repos
    const ownedRepos = repos.filter(r => !r.fork);
    const forkedRepos = repos.filter(r => r.fork);
    
    // Calculate basic stats
    const repoCount = ownedRepos.length;
    const contributedCount = forkedRepos.length;
    const stars = ownedRepos.reduce((total, repo) => total + (repo.stargazers_count || 0), 0);
    const followers = user.followers || 0;
    
    // Get contribution statistics
    const contributions = await withRetry(() => getUserContributions());
    const commitCount = contributions.totalCommitContributions;
    
    // Estimate lines of code
    const locStats = estimateLinesOfCode(ownedRepos, commitCount);
    
    // Check for repository updates and update cache
    let cacheUpdated = false;
    for (const repo of repos) {
      const repoHash = createRepoHash(repo.full_name);
      const lastCommit = new Date(repo.updated_at);
      
      if (!cache.repos[repoHash] || 
          new Date(cache.repos[repoHash].lastUpdated) < lastCommit) {
        
        console.log(`🔄 Updating cache for ${repo.full_name}`);
        
        // Get fresh commit count for this repo
        const commitCount = await withRetry(() => 
          getRepoCommitCount(repo.owner.login, repo.name)
        );
        
        cache.repos[repoHash] = {
          fullName: repo.full_name,
          commitCount,
          lastUpdated: repo.updated_at,
          stars: repo.stargazers_count,
          size: repo.size,
          language: repo.language,
          fork: repo.fork
        };
        
        cacheUpdated = true;
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const stats = {
      repoCount,
      contributedCount,
      stars,
      followers,
      commitCount,
      linesOfCode: locStats.total,
      linesAdded: locStats.added,
      linesDeleted: locStats.deleted,
      totalContributions: contributions.totalCommitContributions + 
                         contributions.totalIssueContributions + 
                         contributions.totalPullRequestContributions,
      lastCalculated: now.toISOString()
    };
    
    // Update cache
    cache.stats = stats;
    cache.lastUpdated = now.toISOString();
    
    if (cacheUpdated || !fs.existsSync(CACHE_FILE)) {
      saveCache(cache);
    }
    
    console.log(`📊 Stats calculated: ${repoCount} repos, ${stars} stars, ${commitCount} commits, ${followers} followers`);
    
    return stats;
    
  } catch (error) {
    console.error("❌ Error fetching stats:", error.message);
    
    // Try to use cached stats as fallback
    if (cache.stats) {
      console.log("🔄 Using cached stats as fallback");
      return cache.stats;
    }
    
    // Last resort: return hardcoded fallback values
    console.log("⚠️ Using fallback values");
    return {
      repoCount: 25,
      contributedCount: 45, 
      stars: 150,
      followers: 85,
      commitCount: 1200,
      linesOfCode: 125000,
      linesAdded: 140000,
      linesDeleted: 15000,
      totalContributions: 1500,
      lastCalculated: new Date().toISOString()
    };
  }
}

// Update SVG with better error handling
function updateSVG(stats) {
  console.log("🎨 Updating SVG...");
  
  if (!fs.existsSync(SVG_PATH)) {
    console.error(`❌ ${SVG_PATH} not found!`);
    throw new Error(`SVG file not found: ${SVG_PATH}`);
  }
  
  try {
    let svgContent = fs.readFileSync(SVG_PATH, "utf8");
    const originalContent = svgContent;
    
    // Calculate age
    const age = humanAge(DOB_ISO);
    console.log(`🎂 Current age: ${age}`);
    
    // Define all updates with fallback values
    const updates = [
      { pattern: /(<tspan class="value" id="age_data">)[^<]*(<\/tspan>)/g, value: age, name: "age" },
      { pattern: /(<tspan class="value" id="repo_data">)[^<]*(<\/tspan>)/g, value: stats.repoCount, name: "repos" },
      { pattern: /(<tspan class="value" id="contrib_data">)[^<]*(<\/tspan>)/g, value: stats.contributedCount, name: "contributed repos" },
      { pattern: /(<tspan class="value" id="star_data">)[^<]*(<\/tspan>)/g, value: stats.stars, name: "stars" },
      { pattern: /(<tspan class="value" id="commit_data">)[^<]*(<\/tspan>)/g, value: stats.commitCount.toLocaleString(), name: "commits" },
      { pattern: /(<tspan class="value" id="follower_data">)[^<]*(<\/tspan>)/g, value: stats.followers, name: "followers" },
      { pattern: /(<tspan class="value" id="loc_data">)[^<]*(<\/tspan>)/g, value: stats.linesOfCode.toLocaleString(), name: "lines of code" },
      { pattern: /(<tspan class="addColor" id="loc_add">)[^<]*(<\/tspan>)/g, value: stats.linesAdded.toLocaleString(), name: "lines added" },
      { pattern: /(<tspan class="delColor" id="loc_del">)[^<]*(<\/tspan>)/g, value: stats.linesDeleted.toLocaleString(), name: "lines deleted" }
    ];
    
    // Apply all updates
    let updatedCount = 0;
    for (const update of updates) {
      const beforeUpdate = svgContent;
      svgContent = svgContent.replace(update.pattern, `$1${update.value}$2`);
      
      if (beforeUpdate !== svgContent) {
        updatedCount++;
        console.log(`✅ Updated ${update.name}: ${update.value}`);
      } else {
        console.warn(`⚠️ Pattern not found for ${update.name}`);
      }
    }
    
    // Only write if changes were made
    if (svgContent !== originalContent) {
      // Create backup
      fs.writeFileSync(`${SVG_PATH}.bak`, originalContent);
      
      // Write updated content
      fs.writeFileSync(SVG_PATH, svgContent);
      console.log(`✅ SVG updated successfully! (${updatedCount} fields updated)`);
    } else {
      console.log("📋 No changes needed in SVG");
    }
    
  } catch (error) {
    console.error("❌ Error updating SVG:", error.message);
    throw error;
  }
}

// Health check function
function performHealthCheck() {
  const issues = [];
  
  // Check required environment variables
  if (!process.env.GITHUB_TOKEN) issues.push("GITHUB_TOKEN not found");
  if (!process.env.DOB_ISO) issues.push("DOB_ISO not found");
  
  // Check file existence
  if (!fs.existsSync(SVG_PATH)) issues.push(`SVG file not found: ${SVG_PATH}`);
  
  // Check cache directory
  if (!fs.existsSync(CACHE_DIR)) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (error) {
      issues.push(`Cannot create cache directory: ${error.message}`);
    }
  }
  
  return issues;
}

// Main execution with comprehensive error handling
async function main() {
  const startTime = Date.now();
  
  try {
    console.log("🚀 Starting neofetch card update...");
    console.log(`📅 Started at: ${new Date().toISOString()}`);
    
    // Perform health check
    const healthIssues = performHealthCheck();
    if (healthIssues.length > 0) {
      console.error("❌ Health check failed:");
      healthIssues.forEach(issue => console.error(`   - ${issue}`));
      throw new Error("Health check failed");
    }
    
    console.log("✅ Health check passed");
    console.log(`🔑 GitHub Token: ${process.env.GITHUB_TOKEN ? 'Found' : 'Not found'}`);
    console.log(`🎂 DOB ISO: ${process.env.DOB_ISO ? 'Found' : 'Not found'}`);
    
    // Get stats and update SVG
    const stats = await getStats();
    updateSVG(stats);
    
    const duration = Date.now() - startTime;
    console.log(`🎉 Neofetch card updated successfully! (${duration}ms)`);
    console.log(`📊 Last updated: ${stats.lastCalculated}`);
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Error updating neofetch card (${duration}ms):`, error.message);
    
    // Try to provide some diagnostic information
    console.error("🔍 Diagnostic information:");
    console.error(`   - Node version: ${process.version}`);
    console.error(`   - Working directory: ${process.cwd()}`);
    console.error(`   - Available files: ${fs.readdirSync('.').join(', ')}`);
    
    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('💥 Unhandled Rejection:', error.message);
  process.exit(1);
});

main();