import { createBackendApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createBackendApp(config);

app.listen(config.port, () => {
  console.info(`gmail-glean-reply-drafter backend listening on ${config.port}`);
});
