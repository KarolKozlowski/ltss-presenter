export function createLtssClient(options = {}) {
  const baseUrl = (options.baseUrl ?? detectBaseUrl()).replace(/\/$/, "");
  const apiPath = (options.apiPath || "/api").replace(/\/$/, "");

  function buildUrl(path) {
    if (!baseUrl) {
      return path;
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${baseUrl}${normalizedPath}`;
  }

  async function fetchJson(path, params) {
    const url = new URL(buildUrl(`${apiPath}${path}`), window.location.origin);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      });
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  return {
    fetchConfig() {
      return fetchJson("/config");
    },
    fetchMetrics() {
      return fetchJson("/metrics");
    },
    fetchTimeseries(params) {
      return fetchJson("/timeseries", params);
    },
  };
}

function detectBaseUrl() {
  const base = new URL(".", window.location.href);
  const path = base.pathname.replace(/\/$/, "");
  return path === "/" ? "" : path;
}
