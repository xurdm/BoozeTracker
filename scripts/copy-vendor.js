// Copies the prebuilt Chart.js UMD bundle into public/vendor/ so it can be
// loaded via a plain <script> tag without a bundler.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.js");
const destDir = path.join(__dirname, "..", "public", "vendor");
const dest = path.join(destDir, "chart.umd.js");

if (!fs.existsSync(src)) {
  console.error("Could not find Chart.js UMD build at", src);
  console.error("Did you run `npm install`?");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("Copied Chart.js ->", path.relative(process.cwd(), dest));
