import { createHmac, randomBytes } from "node:crypto";

/**
 * Minimal WooCommerce REST API (wc/v3) client.
 *
 * WooCommerce only accepts consumer key/secret as HTTP Basic auth when WordPress
 * believes the request is HTTPS. Inside the cluster we talk plain HTTP to the
 * WordPress Service, so we sign every request with OAuth 1.0a (one-legged), which is
 * the method WooCommerce documents for non-TLS connections.
 *
 * WooCommerce rebuilds the signature base string from `get_home_url()` (the public
 * site URL), not from the Host we connect to, so we sign against `siteUrl` while
 * sending the request to `baseUrl` (the internal Service).
 */
export interface WooConfig {
  baseUrl: string; // e.g. http://store-wordpress.store.svc.cluster.local
  siteUrl: string; // e.g. http://store.localhost (WordPress "home" option)
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
}

export class WooError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// PHP rawurlencode() semantics (RFC 3986), which is what WooCommerce uses.
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function oauthSign(
  method: string,
  signingUrl: string,
  params: Record<string, string>,
  consumerSecret: string,
): string {
  const normalized = Object.entries(params)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => rfc3986(`${k}=${v}`))
    .join("%26");
  const base = `${method.toUpperCase()}&${rfc3986(signingUrl)}&${normalized}`;
  return createHmac("sha256", `${consumerSecret}&`).update(base).digest("base64");
}

export class WooClient {
  private readonly internal: URL;
  private readonly site: URL;

  constructor(private readonly cfg: WooConfig) {
    this.internal = new URL(cfg.baseUrl);
    this.site = new URL(cfg.siteUrl);
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const route = `/wp-json/wc/v3${path}`;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") query[k] = String(v);
    }

    const url = new URL(route, this.internal);
    const headers: Record<string, string> = { Accept: "application/json" };

    if (this.internal.protocol === "https:") {
      const token = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
      headers.Authorization = `Basic ${token}`;
    } else {
      const oauth: Record<string, string> = {
        oauth_consumer_key: this.cfg.consumerKey,
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_nonce: randomBytes(16).toString("hex"),
        oauth_signature_method: "HMAC-SHA256",
      };
      // WordPress computes the scheme with is_ssl(), i.e. the scheme of *this* hop.
      const signingUrl = `${this.internal.protocol}//${this.site.host}${this.site.pathname.replace(/\/$/, "")}${route}`;
      const signature = oauthSign(method, signingUrl, { ...query, ...oauth }, this.cfg.consumerSecret);
      Object.assign(query, oauth, { oauth_signature: signature });
    }

    url.search = Object.entries(query)
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .join("&");

    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "manual",
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        throw new WooError(`WooCommerce did not respond within ${this.cfg.timeoutMs}ms`, 504, "store_timeout");
      }
      throw new WooError(`Cannot reach the store: ${e.message}`, 502, "store_unreachable");
    }

    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON (e.g. PHP fatal, HTML error page) */
    }
    if (!res.ok) {
      const d = data as { message?: string; code?: string } | undefined;
      throw new WooError(
        d?.message ?? `WooCommerce returned HTTP ${res.status}`,
        res.status,
        d?.code ?? "store_error",
      );
    }
    if (data === undefined) throw new WooError("WooCommerce returned a non-JSON response", res.status, "bad_response");
    return data as T;
  }
}
