import { execSync } from "node:child_process";

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// 1. typecheck
run("npx tsc --noEmit");
// 2. tests (miniflare + unit; live spikes excluded by default)
run("npx vitest run");
// 3. deploy
run("npx wrangler deploy");
// 4. sentry sourcemaps (if SENTRY_DSN/SENTRY_AUTH_TOKEN present)
if (process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_DSN) {
  try {
    run("npx sentry-cli sourcemaps upload --org toolbear --project lilium-chat ./dist || true");
  } catch (e) {
    console.warn("sentry upload skipped/failed", e.message);
  }
} else {
  console.log("> sentry upload skipped (no SENTRY_AUTH_TOKEN/SENTRY_DSN)");
}
