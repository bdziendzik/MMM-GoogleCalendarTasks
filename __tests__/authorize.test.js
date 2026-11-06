const { extractAuthCode } = require("../authorize.js");

describe("extractAuthCode", () => {
  test("reads the code query parameter from a redirect URL", () => {
    expect(
      extractAuthCode("http://localhost/?code=4%2F0Aabc&scope=email")
    ).toBe("4/0Aabc");
  });

  test("accepts a URL without a scheme", () => {
    expect(extractAuthCode("localhost:80/?code=abc123")).toBe("abc123");
  });

  test("accepts a raw authorization code", () => {
    expect(extractAuthCode("  4/0Aabc  ")).toBe("4/0Aabc");
  });

  test("strips surrounding quotes", () => {
    expect(extractAuthCode('"http://localhost/?code=abc"')).toBe("abc");
  });

  test("returns an empty string when a URL has no code", () => {
    expect(extractAuthCode("http://localhost/?error=access_denied")).toBe("");
  });
});
