import { Request, Response } from "express";
import { getOpenAiModels } from "../models";

/** GET /v1/models — live upstream catalog in OpenAI format (with `-thinking` variants). */
export async function listModels(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getOpenAiModels();
    res.json({ object: "list", data });
  } catch (err) {
    res.status(502).json({
      error: {
        message: `Failed to load model list: ${(err as Error).message}`,
        type: "api_error",
      },
    });
  }
}
