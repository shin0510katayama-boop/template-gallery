const fs = require("fs");

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7);
const builtAt = new Date().toISOString();

fs.writeFileSync(
  "version.js",
  `window.APP_VERSION = ${JSON.stringify(sha)};\nwindow.APP_BUILT_AT = ${JSON.stringify(builtAt)};\n`
);
