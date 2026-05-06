import "dotenv/config";

export interface AppConfig {
  port: number;
  host: string;
  sharedSecret?: string;
  gleanServerUrl?: string;
  gleanApiToken?: string;
  gleanTimeoutMs: number;
  gleanStubMode: boolean;
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST?.trim() || "127.0.0.1",
    gleanTimeoutMs: Number(process.env.GLEAN_TIMEOUT_MS ?? 15000),
    gleanStubMode: (process.env.GLEAN_STUB_MODE ?? "false").toLowerCase() === "true",
  };

  const sharedSecret = process.env.BACKEND_SHARED_SECRET?.trim();
  const gleanServerUrl = process.env.GLEAN_SERVER_URL?.trim();
  const gleanApiToken = process.env.GLEAN_API_TOKEN?.trim();

  if (sharedSecret) config.sharedSecret = sharedSecret;
  if (gleanServerUrl) config.gleanServerUrl = gleanServerUrl;
  if (gleanApiToken) config.gleanApiToken = gleanApiToken;

  return config;
}
