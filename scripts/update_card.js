// scripts/update_card.js
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import fs from "fs";
import { JSDOM } from "jsdom";

const USER = "officialaritro";
const SVG_PATH = "aritro-neofetch.svg";
const DOB_ISO = process.env.DOB_ISO;

// Calculate human-readable age from DOB
function humanAge(fromISO) {
  if (!fromISO) return "—";
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

// Initialize GitHub API clients
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const gql = graphql.defaults({ 
  headers: { authorization: `token ${process.env.GITHUB_TOKEN}` } 
});

// Get GitHub statistics
async function getStats() {
  console.log("Fetching GitHub stats...");
  
  // Get user data
  const { data: user } = await octokit.rest.users.getByUsername({ username: USER });
  
  // Get all repositories
  const repos = await octokit.paginate(octokit.rest.repos.listForUser, { 
    username: USER, 
    per_page: 100 
  });
  
  // Filter owned repos (non-forks)
  const ownedRepos = repos.filter(r => !r.fork);
  const forkedRepos = repos.filter(r => r.fork);
  
  // Calculate basic stats
  const repoCount = ownedRepos.length;
  const contributedCount = forkedRepos.length;
  const stars = ownedRepos.reduce((total, repo) => total + (repo.stargazers_count || 0), 0);
  const followers = user.followers || 0;
  
  // Get commit count using GraphQL
  const { user: contributionsData } = await gql(`
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
        }
      }
    }
  `, { login: USER });
  
  const commitCount = contributionsData.contributionsCollection.totalCommitContributions;
  
  // Estimate lines of code (simplified approach)
  // Use a multiplier based on commits and repositories
  const avgLinesPerCommit = 50; // Conservative estimate
  const linesOfCode = Math.floor(commitCount * avgLinesPerCommit);
  const linesAdded = Math.floor(linesOfCode * 1.15); // 15% more additions than net
  const linesDeleted = linesAdded - linesOfCode;
  
  console.log(`Stats: ${repoCount} repos, ${stars} stars, ${commitCount} commits, ${followers} followers`);
  
  return {
    repoCount,
    contributedCount, 
    stars,
    followers,
    commitCount,
    linesOfCode,
    linesAdded,
    linesDeleted
  };
}

// Update SVG with new data and justify dots
function updateSVG(stats) {
  console.log("Updating SVG...");
  
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  const doc = dom.window.document;
  
  // Helper function to set text content by ID
  const setText = (id, value) => {
    const element = doc.getElementById(id);
    if (element) {
      element.textContent = String(value);
    } else {
      console.warn(`Element with id '${id}' not found`);
    }
  };
  
  // Helper function to justify dots (similar to inspiration repo)
  const justifyDots = (dotsId, value, targetLength) => {
    const valueStr = typeof value === 'number' ? value.toLocaleString() : String(value);
    const dotsNeeded = Math.max(0, targetLength - valueStr.length);
    let dotString = '';
    
    if (dotsNeeded <= 2) {
      const dotMap = {0: '', 1: ' ', 2: '. '};
      dotString = dotMap[dotsNeeded] || '';
    } else {
      dotString = ' ' + '.'.repeat(dotsNeeded) + ' ';
    }
    
    const dotsElement = doc.getElementById(dotsId);
    if (dotsElement) {
      dotsElement.textContent = ': ' + dotString.substring(2); // Remove ': ' and add it back
    }
  };
  
  // Update all the data
  setText("age_data", humanAge(DOB_ISO));
  setText("repo_data", stats.repoCount);
  setText("contrib_data", stats.contributedCount);
  setText("star_data", stats.stars);
  setText("commit_data", stats.commitCount.toLocaleString());
  setText("follower_data", stats.followers);
  setText("loc_data", stats.linesOfCode.toLocaleString());
  setText("loc_add", stats.linesAdded.toLocaleString());
  setText("loc_del", stats.linesDeleted.toLocaleString());
  
  // Justify dots for proper alignment
  justifyDots("repo_data_dots", stats.repoCount, 6);
  justifyDots("star_data_dots", stats.stars, 11);
  justifyDots("commit_data_dots", stats.commitCount.toLocaleString(), 18);
  justifyDots("follower_data_dots", stats.followers, 8);
  justifyDots("loc_data_dots", stats.linesOfCode.toLocaleString(), 1);
  
  // Write the updated SVG
  fs.writeFileSync(SVG_PATH, dom.serialize());
  console.log("✅ SVG updated successfully!");
}

// Main execution
async function main() {
  try {
    console.log("Starting neofetch card update...");
    const stats = await getStats();
    updateSVG(stats);
    console.log("🎉 Neofetch card updated successfully!");
  } catch (error) {
    console.error("❌ Error updating neofetch card:", error);
    process.exit(1);
  }
}

main();
