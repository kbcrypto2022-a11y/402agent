/**
 * READ — retrieve and accurately extract information from a URL.
 *
 * SSRF-protected (scheme/host/IP/DNS validation on every redirect hop).
 * Extracted items are explicitly labeled `stated` (explicit in the source),
 * `interpretation`, or `inference` — an inference is never represented as a
 * direct fact from the source.
 */

import { z } from "zod";
import { ChargedCallError, type AIProvider } from "../providers";
import {
  safeFetchText,
  SafeFetchError,
  UnsafeUrlError,
} from "../security/ssrf";
import { ApiError } from "../security/errors";
import { htmlTitle, htmlToText } from "../utils/html";
import { paidCall, withRetries, type SpendContext } from "./spend";

/** Nominal bandwidth/compute cost attributed to a content fetch. */
const FETCH_COST_USD = 0.0005;
const MAX_CONTENT_CHARS = 24_000;

export const FACT_TYPES = ["stated", "interpretation", "inference"] as const;

const extractionSchema = z.object({
  title: z.string().default(""),
  summary: z.string().default(""),
  key_points: z.array(z.string()).default([]),
  extracted_facts: z
    .array(
      z.object({
        statement: z.string(),
        type: z.enum(FACT_TYPES),
        source_quote: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export interface ReadResponse {
  service: "read";
  title: string;
  summary: string;
  key_points: string[];
  extracted_facts: Array<{
    statement: string;
    /** "stated" | "interpretation" | "inference" */
    type: (typeof FACT_TYPES)[number];
    source_quote: string | null;
  }>;
  source_url: string;
  generated_at: string;
}

export async function fetchReadableContent(
  url: string,
  ctx: SpendContext,
  fetchText: typeof safeFetchText = safeFetchText,
): Promise<{ title: string | null; text: string; finalUrl: string }> {
  const fetched = await paidCall(
    ctx,
    "other",
    FETCH_COST_USD,
    "content fetch",
    async () => {
      try {
        const res = await fetchText(url);
        return { value: res, actualCost: FETCH_COST_USD };
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          throw new ApiError(400, "INVALID_REQUEST", `URL rejected: ${err.message}`);
        }
        if (err instanceof SafeFetchError) {
          throw new ApiError(
            502,
            "SOURCE_UNAVAILABLE",
            "The source URL could not be fetched.",
          );
        }
        throw new ApiError(
          502,
          "SOURCE_UNAVAILABLE",
          "The source URL could not be fetched.",
        );
      }
    },
  );
  if (fetched.status >= 400) {
    throw new ApiError(
      502,
      "SOURCE_UNAVAILABLE",
      `The source returned HTTP ${fetched.status}.`,
    );
  }
  const isHtml = /html|xml/i.test(fetched.contentType);
  const text = isHtml ? htmlToText(fetched.body) : fetched.body;
  return {
    title: isHtml ? htmlTitle(fetched.body) : null,
    text: text.slice(0, MAX_CONTENT_CHARS),
    finalUrl: fetched.finalUrl,
  };
}

export async function runRead(
  url: string,
  provider: AIProvider,
  ctx: SpendContext,
): Promise<ReadResponse> {
  const content = await fetchReadableContent(url, ctx);
  if (content.text.trim().length < 40) {
    throw new ApiError(
      502,
      "SOURCE_UNAVAILABLE",
      "The source contained no extractable text content.",
    );
  }

  const input = `SOURCE URL: ${content.finalUrl}\nPAGE TITLE: ${content.title ?? "(none)"}\n\nCONTENT:\n${content.text}`;
  const instructions =
    `Extract structured information as JSON {"title","summary","key_points":[],"extracted_facts":[{"statement","type","source_quote"}]}. ` +
    `Every extracted_facts.type MUST be exactly one of: "stated" (explicitly written in the content — include the supporting source_quote), ` +
    `"interpretation" (a reasonable reading of what the content says), "inference" (a conclusion the content does not itself state). ` +
    `NEVER label an inference or interpretation as "stated". Do not add outside knowledge. summary must be faithful to the content only.`;

  const extracted = await withRetries(ctx.config.maxRetries, async (attempt) =>
    paidCall(
      ctx,
      "ai",
      provider.estimateCallCost("extract", input.length),
      attempt === 0 ? "content extraction" : "content extraction (retry)",
      async () => {
        const out = await provider.extract(input, instructions);
        const meta = {
          provider: provider.name,
          model: out.usage.model,
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
          ...(attempt > 0 ? { retry: true } : {}),
        };
        const parsed = extractionSchema.safeParse(out.data);
        if (!parsed.success) {
          // Charged, but output unusable — cost still must be recorded.
          throw new ChargedCallError(
            "Extraction output failed validation",
            out.usage.estimatedCostUsd,
            meta,
            { cause: parsed.error },
          );
        }
        return {
          value: parsed.data,
          actualCost: out.usage.estimatedCostUsd,
          meta,
        };
      },
    ),
  );

  return {
    service: "read",
    title: extracted.title || content.title || content.finalUrl,
    summary: extracted.summary,
    key_points: extracted.key_points,
    extracted_facts: extracted.extracted_facts,
    source_url: content.finalUrl,
    generated_at: new Date().toISOString(),
  };
}
