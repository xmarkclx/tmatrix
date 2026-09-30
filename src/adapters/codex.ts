import { AppServerCodex } from "../app-server-codex.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";

/** Bundled by the same engine build as the loader; no separate install needed. */
export default {
  apiVersion: 1,
  id: "codex",
  create: ({ environment, logger }) => new AppServerCodex({ environment, logger })
} satisfies RuntimeAdapter;
