/**
 * Type-safe helper functions for Context
 * Replaces unsafe 'as any' casts throughout the codebase
 */

import { asSessionToken, type SessionToken } from "../../types/common.js";
import type { Context } from "../views/index.js";

/**
 * Safely extract SessionToken from context
 * Returns undefined if session token is not present or invalid
 */
export function getSessionToken(ctx: Context): SessionToken | undefined {
  const token = ctx.session.sessionToken;
  if (!token || typeof token !== "string") {
    return undefined;
  }
  return asSessionToken(token);
}

/**
 * Safely extract UI message ID from context
 * Returns undefined if UI state or messageId is not present
 */
export function getUIMessageId(ctx: Context): number | undefined {
  return ctx.session.ui?.messageId;
}
