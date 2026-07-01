export function createJsonApiClient({ baseUrl, token, throwOnError = true, includeStatus = false }) {
  return async function api(pathname, options = {}) {
    const root = typeof baseUrl === "function" ? baseUrl() : baseUrl;
    const { token: requestToken, ...fetchOptions } = options;
    const configuredToken = typeof token === "function" ? token() : token;
    const bearer = requestToken === undefined ? configuredToken : requestToken;
    const response = await fetch(`${root}${pathname}`, {
      ...fetchOptions,
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(fetchOptions.headers || {})
      },
      body: fetchOptions.body && typeof fetchOptions.body !== "string" ? JSON.stringify(fetchOptions.body) : fetchOptions.body
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (throwOnError && !response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return includeStatus ? { status: response.status, data } : data;
  };
}
