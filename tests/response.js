export function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    typeValue: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    type(value) {
      this.typeValue = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}
