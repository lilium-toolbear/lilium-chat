/** Browser origins permitted for HTTP CORS and WebSocket upgrade. */
export const ALLOWED_BROWSER_ORIGINS = [
  "https://lilium.kuma.homes",
  // toolbear_ui (vite default)
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  // toolbear_ui (FastAPI serves built SPA)
  "http://localhost:3334",
  "http://127.0.0.1:3334",
] as const;

export const ALLOWED_BROWSER_ORIGIN_SET = new Set<string>(ALLOWED_BROWSER_ORIGINS);
