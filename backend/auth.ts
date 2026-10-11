import { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { PROXY_API_KEY } from "./utils/config";

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Bearer authentication for every `/v1/*` and `/api/v1/*` route.
 * The accepted key is the PROXY_API_KEY environment variable (Vorflux Secrets).
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header: string = (req.headers.authorization as string) || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (
    !PROXY_API_KEY ||
    !match ||
    !constantTimeEqual(match[1].trim(), PROXY_API_KEY)
  ) {
    res.status(401).json({
      error: {
        message:
          "Invalid API key. Send 'Authorization: Bearer <PROXY_API_KEY>'.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }
  next();
}
