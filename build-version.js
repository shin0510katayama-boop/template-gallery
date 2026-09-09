const fs = require("fs");

const { version } = require("./package.json");
const builtAt = new Date().toISOString();

fs.writeFileSync(
  "version.js",
  `window.APP_VERSION = ${JSON.stringify(version)};\nwindow.APP_BUILT_AT = ${JSON.stringify(builtAt)};\n`
);
