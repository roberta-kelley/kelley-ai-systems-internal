const NOTION_VERSION = "2025-09-03";
const DEFAULT_ORIGIN = "https://roberta-kelley.github.io";

type NotionProperty = {
  type?: string;
  [key: string]: unknown;
};

type NotionPage = {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionProperty>;
};

const env = (name: string) => Deno.env.get(name)?.trim() || "";
const RESTRICTED_RESEARCH_HOSTS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "maps.google.com",
]);

const corsHeaders = (request: Request) => {
  const origin = request.headers.get("origin") || "";
  const allowed = env("PHOENIX_ALLOWED_ORIGIN") || DEFAULT_ORIGIN;
  return {
    "Access-Control-Allow-Origin": origin === allowed ? origin : allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const plainText = (items: unknown) =>
  Array.isArray(items)
    ? items
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const value = item as Record<string, unknown>;
        return String(value.plain_text || "");
      })
      .join("")
      .trim()
    : "";

const propertyText = (property?: NotionProperty): string => {
  if (!property?.type) return "";
  const value = property[property.type];
  switch (property.type) {
    case "title":
    case "rich_text":
      return plainText(value);
    case "email":
    case "phone_number":
    case "url":
    case "created_time":
    case "last_edited_time":
      return typeof value === "string" ? value.trim() : "";
    case "select":
    case "status":
      return value && typeof value === "object"
        ? String((value as Record<string, unknown>).name || "").trim()
        : "";
    case "multi_select":
      return Array.isArray(value)
        ? value
          .map((item) => item && typeof item === "object"
            ? String((item as Record<string, unknown>).name || "").trim()
            : "")
          .filter(Boolean)
          .join(", ")
        : "";
    case "date":
      return value && typeof value === "object"
        ? String((value as Record<string, unknown>).start || "").trim()
        : "";
    case "checkbox":
      return value === true ? "Yes" : value === false ? "No" : "";
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "formula": {
      if (!value || typeof value !== "object") return "";
      const formula = value as Record<string, unknown>;
      const formulaValue = formula[typeof formula.type === "string" ? formula.type : ""];
      return formulaValue === null || formulaValue === undefined ? "" : String(formulaValue);
    }
    default:
      return "";
  }
};

const normalizePage = (page: NotionPage) => {
  const properties = page.properties || {};
  const row = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [name, propertyText(property)]),
  );
  return {
    ...row,
    "Notion Page ID": page.id || "",
    "Notion Page URL": page.url || "",
    "Notion Last Edited": page.last_edited_time || "",
  };
};

const authenticateOwner = async (request: Request) => {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw new Error("AUTH_REQUIRED");
  }
  const supabaseUrl = env("SUPABASE_URL");
  const publishableKey = env("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !publishableKey) throw new Error("SERVER_CONFIG");
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      "Authorization": authorization,
      "apikey": publishableKey,
    },
  });
  if (!response.ok) throw new Error("AUTH_REQUIRED");
  const user = await response.json();
  const allowedEmail = env("PHOENIX_ALLOWED_EMAIL").toLowerCase();
  if (allowedEmail && String(user.email || "").toLowerCase() !== allowedEmail) {
    throw new Error("OWNER_REQUIRED");
  }
  return user;
};

const queryNotion = async () => {
  const token = env("NOTION_TOKEN");
  const dataSourceId = env("NOTION_DATA_SOURCE_ID");
  if (!token || !dataSourceId) throw new Error("NOTION_CONFIG");
  const rows: Record<string, string>[] = [];
  let cursor = "";
  do {
    const response = await fetch(
      `https://api.notion.com/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) {
      const message = typeof data?.message === "string" ? data.message : "Notion could not be read.";
      throw new Error(`NOTION_ERROR:${message}`);
    }
    rows.push(...(Array.isArray(data.results) ? data.results.map(normalizePage) : []));
    cursor = data.has_more && data.next_cursor ? String(data.next_cursor) : "";
  } while (cursor);
  return rows.filter((row) => String(row["Prospect / Company"] || "").trim());
};

const permittedResearchUrl = (value: unknown) => {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("RESEARCH_URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("RESEARCH_URL");
  const host = url.hostname.toLowerCase();
  if (
    RESTRICTED_RESEARCH_HOSTS.has(host) ||
    host.endsWith(".linkedin.com") ||
    host.endsWith(".facebook.com") ||
    host.endsWith(".instagram.com") ||
    (host.includes("google.") && url.pathname.toLowerCase().includes("/maps"))
  ) {
    throw new Error("RESEARCH_RESTRICTED");
  }
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("RESEARCH_PRIVATE");
  }
  url.hash = "";
  return url.href;
};

const researchTitle = (text: string) => {
  const match = text.match(/^Title:\s*(.+)$/m);
  return match ? match[1].trim() : "Public webpage";
};

const readResearchPages = async (values: unknown) => {
  if (!Array.isArray(values)) throw new Error("RESEARCH_URL");
  const urls = [...new Set(values.map(permittedResearchUrl))].slice(0, 4);
  if (!urls.length) throw new Error("RESEARCH_URL");
  return await Promise.all(urls.map(async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`https://r.jina.ai/${url}`, {
        headers: { "Accept": "text/plain" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Reader returned ${response.status}`);
      const text = (await response.text()).slice(0, 18000);
      return {
        url,
        title: researchTitle(text),
        text,
        status: "read",
        accessed_at: new Date().toISOString(),
      };
    } catch (problem) {
      const error = problem instanceof DOMException && problem.name === "AbortError"
        ? "The reader timed out after 25 seconds."
        : problem instanceof Error ? problem.message : "The page could not be read.";
      return {
        url,
        title: "Page could not be read",
        text: "",
        status: "unavailable",
        error,
        accessed_at: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }));
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  const origin = request.headers.get("origin") || "";
  const allowed = env("PHOENIX_ALLOWED_ORIGIN") || DEFAULT_ORIGIN;
  if (origin && origin !== allowed) return json(request, { error: "Origin not allowed." }, 403);
  try {
    await authenticateOwner(request);
    const body = await request.json().catch(() => ({}));
    if (body?.action === "research_pages") {
      const pages = await readResearchPages(body.urls);
      return json(request, {
        pages,
        source: "Phoenix protected public-page reader",
        read_at: new Date().toISOString(),
      });
    }
    const prospects = await queryNotion();
    return json(request, {
      prospects,
      source: "Kelley AI Systems — Prospect & Outreach CRM",
      synced_at: new Date().toISOString(),
    });
  } catch (problem) {
    const message = problem instanceof Error ? problem.message : "";
    if (message === "AUTH_REQUIRED") return json(request, { error: "Please sign in to Phoenix again." }, 401);
    if (message === "OWNER_REQUIRED") return json(request, { error: "This Notion connection is restricted to the Phoenix owner." }, 403);
    if (message === "SERVER_CONFIG" || message === "NOTION_CONFIG") {
      return json(request, { error: "The private Notion connection has not been configured yet." }, 503);
    }
    if (message === "RESEARCH_URL") return json(request, { error: "Add at least one complete public webpage URL." }, 400);
    if (message === "RESEARCH_RESTRICTED") {
      return json(request, { error: "Phoenix does not automatically read LinkedIn, Google Maps, Facebook, or Instagram." }, 400);
    }
    if (message === "RESEARCH_PRIVATE") return json(request, { error: "Private or local network addresses cannot be researched." }, 400);
    if (message.startsWith("NOTION_ERROR:")) return json(request, { error: message.slice(13) }, 502);
    return json(request, { error: "Phoenix could not read the Notion CRM." }, 500);
  }
});
