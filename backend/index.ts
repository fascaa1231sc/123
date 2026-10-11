import express, { Request, Response, NextFunction } from "express";
import * as path from "path";
import * as fs from "fs";
import { requireAuth } from "./auth";
import { listModels } from "./routes/models";
import { chatCompletions } from "./routes/chat";
import { getStatusModels } from "./models";
import { PORT, PROXY_API_KEY, VORFLUX_API_KEY } from "./utils/config";

const app = express();

// Large body limit so base64 image payloads pass through.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ---- Public endpoints (status page support) ----

// Health check for the status page and monitors.
app.get("/api/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Grouped model catalog for the status page (public catalog metadata only).
app.get("/api/status/models", async (_req: Request, res: Response) => {
  try {
    res.json(await getStatusModels());
  } catch (err) {
    res
      .status(502)
      .json({ error: { message: (err as Error).message, type: "api_error" } });
  }
});

// ---- OpenAI-compatible API: mounted identically under /v1 and /api/v1 ----
const apiRouter = express.Router();
apiRouter.get("/models", listModels);
apiRouter.post("/chat/completions", chatCompletions);

app.use("/v1", requireAuth, apiRouter);
app.use("/api/v1", requireAuth, apiRouter);

// ---- Status page (static) ----
const webDir = [
  path.join(__dirname, "..", "..", "web"), // dist/ -> repo/web
  path.join(process.cwd(), "web"),
].find((dir) => fs.existsSync(path.join(dir, "index.html")));

if (webDir) {
  app.use(express.static(webDir));
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(webDir, "index.html"));
  });
}

// ---- Unmatched paths: JSON 404 (never HTML) ----
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: {
      message: `Invalid URL (${req.method} ${req.path})`,
      type: "invalid_request_error",
      code: "not_found",
    },
  });
});

// ---- Error handler: JSON errors only ----
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    error: { message: `Internal server error: ${err.message}`, type: "api_error" },
  });
});

if (!PROXY_API_KEY) {
  console.error("FATAL: PROXY_API_KEY is not set (see backend/.env).");
  process.exit(1);
}
if (!VORFLUX_API_KEY) {
  console.error("FATAL: VORFLUX_API_KEY is not set (Vorflux Secrets).");
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`vorflux-openai-proxy listening on :${PORT}`);
  console.log(`  OpenAI-compatible base: http://localhost:${PORT}/v1 (also /api/v1)`);
  console.log(`  Health:                  http://localhost:${PORT}/api/healthz`);
});
