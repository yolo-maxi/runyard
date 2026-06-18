export class HubClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:43117").replace(/\/$/, "");
    this.token = token;
  }

  async request(path, options = {}) {
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {})
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error || `HTTP ${response.status}`);
      error.response = data;
      throw error;
    }
    return data;
  }

  get(path) {
    return this.request(path);
  }

  post(path, body) {
    return this.request(path, { method: "POST", body });
  }

  patch(path, body) {
    return this.request(path, { method: "PATCH", body });
  }
}
