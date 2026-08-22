import { generateJwt } from "@coinbase/cdp-sdk/auth";
import {
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from "@x402/core/server";
import { CDP_FACILITATOR_URL } from "../../config";
import { PaymentError } from "./mock";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE_PATH = "/platform/v2/x402";

function cdpCredentials(): { apiKeyId: string; apiKeySecret: string } {
  const apiKeyId = process.env["CDP_API_KEY_ID"];
  const apiKeySecret = process.env["CDP_API_KEY_SECRET"];
  if (!apiKeyId || !apiKeySecret) {
    throw new PaymentError(
      "CDP facilitator credentials are not configured",
      "PAYMENT_FAILED",
    );
  }
  return { apiKeyId, apiKeySecret };
}

async function authHeaders(
  path: "verify" | "settle" | "supported",
): Promise<Record<string, string>> {
  const credentials = cdpCredentials();
  const jwt = await generateJwt({
    ...credentials,
    requestMethod: path === "supported" ? "GET" : "POST",
    requestHost: CDP_HOST,
    requestPath: `${CDP_BASE_PATH}/${path}`,
  });
  return {
    Authorization: `Bearer ${jwt}`,
    "Correlation-Context":
      "sdkLanguage=typescript,source=402agent,sourceVersion=0.1.0",
  };
}

/**
 * CDP-authenticated facilitator client.
 *
 * Authentication is intentionally lazy: the app and unpaid 402 quote path can
 * run without credentials, but verify/settle fail explicitly unless the CDP
 * API key secrets are configured.
 */
export function createCdpFacilitatorClient(): FacilitatorClient {
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => ({
      verify: await authHeaders("verify"),
      settle: await authHeaders("settle"),
      supported: await authHeaders("supported"),
    }),
  });
}