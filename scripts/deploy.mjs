import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Load .env into process.env. Existing process env wins (.env never overrides),
// so CI/explicit exports take precedence over committed values.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// 0. regenerate worker types (worker-configuration.d.ts) from wrangler.jsonc
//    so the typecheck below sees current bindings (DOs/Hyperdrive/vars).
run("npx wrangler types");
// 1. typecheck
run("npx tsc --noEmit");
// 2. tests (miniflare + unit; live spikes excluded by default)
run("npx vitest run");
// 3. deploy
run("npx wrangler deploy");
// 4. sentry sourcemaps — only when configured AND a build artifact exists.
//    wrangler bundles internally; ./dist only exists if a separate build step
//    produced it. Skip (warn, don't fail) otherwise.
const sentryConfigured = process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_DSN;
if (sentryConfigured && existsSync("./dist")) {
  try {
    run(
      `npx sentry-cli sourcemaps upload ` +
        `--org ${process.env.SENTRY_ORG} --project ${process.env.SENTRY_PROJECT} ./dist`
    );
  } catch (e) {
    console.warn("> sentry upload failed:", e.message);
  }
} else if (!existsSync("./dist")) {
  console.log("> sentry upload skipped (./dist not built)");
} else {
  console.log("> sentry upload skipped (no SENTRY_AUTH_TOKEN/SENTRY_DSN in .env)");
}