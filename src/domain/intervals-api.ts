export type IntervalsResource = "client" | "project" | "projectworktype" | "projectmodule" | "timer" | "time";

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

export class IntervalsApiClient {
  constructor(private readonly options: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch }) {}

  async listResource(resource: IntervalsResource, query: Record<string, string> = {}): Promise<unknown[]> {
    const items: unknown[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const data = await this.request("GET", resource, undefined, {
        ...query,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const pageItems = extractCollection(data, resource);
      items.push(...pageItems);

      if (pageItems.length < PAGE_SIZE) return items;
    }

    throw new Error(`Exceeded ${MAX_PAGES} pages while fetching ${resource}`);
  }

  async createResource(resource: "timer" | "time", body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", resource, body);
  }

  async updateResource(resource: "timer" | "time", id: number, body: Record<string, unknown>): Promise<unknown> {
    return this.request("PUT", `${resource}/${id}`, body);
  }

  async deleteResource(resource: "timer" | "time", id: number): Promise<unknown> {
    return this.request("DELETE", `${resource}/${id}`);
  }

  private async request(
    method: string,
    resourcePath: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
    const url = new URL(resourcePath.endsWith("/") ? resourcePath : `${resourcePath}/`, base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${this.options.apiKey}:X`).toString("base64")}`,
    };
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(sanitizeApiError(text || `${response.status} ${response.statusText}`, this.options.apiKey));
    return data;
  }
}

export function extractCollection(data: unknown, resource: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const object = data as Record<string, unknown>;
    for (const key of [resource, `${resource}s`, "items", "data"]) {
      if (Array.isArray(object[key])) return object[key];
    }
  }
  return [];
}

export function sanitizeApiError(message: string, apiKey?: string): string {
  let clean = message.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
  if (apiKey) clean = clean.split(apiKey).join("[redacted]");
  return clean;
}
