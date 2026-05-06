import { createBackendApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createBackendApp(config);

app.listen(config.port, config.host, () => {
  console.info(`gmail-glean-reply-drafter backend listening on ${config.host}:${config.port}`);
});
