import fs from "fs";

const SVG_PATH = "aritro-neofetch.svg";
const REQUIRED_PLACEHOLDER_IDS = [
  "age_data",
  "repo_data",
  "contrib_data",
  "star_data",
  "commit_data",
  "follower_data",
  "loc_data",
  "loc_add",
  "loc_del",
];

function checkSvgPlaceholders() {
  if (!fs.existsSync(SVG_PATH)) {
    throw new Error(`Missing SVG file: ${SVG_PATH}`);
  }

  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const missing = REQUIRED_PLACEHOLDER_IDS.filter(
    (id) => !new RegExp(`<tspan\\b[^>]*\\bid="${id}"[^>]*>`, "i").test(svg)
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required SVG placeholder IDs: ${missing.join(", ")}. Expected: ${REQUIRED_PLACEHOLDER_IDS.join(", ")}`
    );
  }

  console.log("SVG placeholder check passed");
  console.log(`Verified IDs: ${REQUIRED_PLACEHOLDER_IDS.join(", ")}`);
}

try {
  checkSvgPlaceholders();
} catch (error) {
  console.error(`Diagnostic failed: ${error.message}`);
  process.exit(1);
}
