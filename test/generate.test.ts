import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, generateCandidate, GenerationError } from "../src/generate.ts";
import { SecretScanError } from "../src/secrets.ts";
import { fixture } from "./fixture.ts";

const candidate = {
  type: "feat",
  scope: "cli",
  description: "read staged changes",
  body: null,
  breaking: false,
  breakingDescription: null,
  footers: [],
};
const diff = "diff --git a/file.txt b/file.txt\n+add staged diff support\n";

function response(text = JSON.stringify(candidate), status = "completed") {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status,
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}

function transport(payload: unknown = response(), status = 200) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(new Request(url, init));
    return Response.json(payload, { status });
  };
  return { requests, fetch };
}

test("uses Responses, strict structured output, a fixed endpoint, and separate instructions", async (t) => {
  const repo = fixture(t, false);
  const mock = transport();
  const env = { ...repo.env, OPENAI_API_KEY: "test-api-key" };
  const result = await generateCandidate(diff, {
    env,
    fetch: mock.fetch,
    temporaryDirectory: repo.cwd,
  });
  assert.deepEqual(result, candidate);
  assert.equal(mock.requests.length, 1);
  const request = mock.requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers.get("authorization"), "Bearer test-api-key");
  const body = JSON.parse(await request.text());
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.truncation, "disabled");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(body.input[0].role, "user");
  assert.deepEqual(JSON.parse(body.input[0].content), { diff });
  assert.ok(!body.instructions.includes(diff));
  assert.match(body.instructions, /untrusted data/);
});

test("supports a model override and provides the previous candidate as data", async (t) => {
  const repo = fixture(t, false);
  const mock = transport();
  await generateCandidate(diff, {
    model: "another-structured-output-model",
    previousCandidate: "feat: inspect staged changes",
    env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
    fetch: mock.fetch,
    temporaryDirectory: repo.cwd,
  });
  const request = mock.requests[0];
  assert.ok(request);
  const body = JSON.parse(await request.text());
  assert.equal(body.model, "another-structured-output-model");
  assert.deepEqual(JSON.parse(body.input[0].content), {
    diff,
    previousCandidate: "feat: inspect staged changes",
  });
});

test("ignores SDK environment overrides for the endpoint and logging", async (t) => {
  const repo = fixture(t, false);
  const saved = { base: process.env.OPENAI_BASE_URL, log: process.env.OPENAI_LOG };
  t.after(() => {
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.base;
    if (saved.log === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = saved.log;
  });
  process.env.OPENAI_BASE_URL = "https://example.invalid/v1";
  process.env.OPENAI_LOG = "debug";
  const debug = t.mock.method(console, "debug", () => {});
  const log = t.mock.method(console, "log", () => {});
  const mock = transport();
  await generateCandidate(diff, {
    env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
    fetch: mock.fetch,
    temporaryDirectory: repo.cwd,
  });
  assert.equal(mock.requests[0]?.url, "https://api.openai.com/v1/responses");
  assert.equal(debug.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 0);
});

test("rejects a missing API key before making a request", async () => {
  const mock = transport();
  await assert.rejects(generateCandidate(diff, { env: {}, fetch: mock.fetch }), /OPENAI_API_KEY/);
  assert.equal(mock.requests.length, 0);
});

test("rejects oversized encoded input without truncating it or making a request", async () => {
  const mock = transport();
  await assert.rejects(
    generateCandidate(diff, {
      env: { OPENAI_API_KEY: "test-api-key" },
      maxInputBytes: 20,
      fetch: mock.fetch,
    }),
    /encoded input exceeds/,
  );
  assert.equal(mock.requests.length, 0);
});

test("refuses to send the runtime API key if it occurs in the diff", async () => {
  const mock = transport();
  await assert.rejects(
    generateCandidate("+test-api-key", {
      env: { OPENAI_API_KEY: "test-api-key" },
      fetch: mock.fetch,
    }),
    /API key occurs/,
  );
  assert.equal(mock.requests.length, 0);
});

test("scans removed and context lines as well as additions before sending", async (t) => {
  const repo = fixture(t, false);
  // Synthetic detector fixture, assembled to avoid committing a credential-shaped literal.
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  for (const prefix of ["+", "-", " "]) {
    const mock = transport();
    await assert.rejects(
      generateCandidate(`${prefix}token = "${token}"\n`, {
        env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      SecretScanError,
    );
    assert.equal(mock.requests.length, 0);
  }
});

test("scans the previous candidate before regeneration", async (t) => {
  const repo = fixture(t, false);
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  const mock = transport();
  await assert.rejects(
    generateCandidate(diff, {
      previousCandidate: `fix: replace token ${token}`,
      env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
      fetch: mock.fetch,
      temporaryDirectory: repo.cwd,
    }),
    SecretScanError,
  );
  assert.equal(mock.requests.length, 0);
});

test("fails closed when the scanner cannot run", async (t) => {
  const repo = fixture(t, false);
  const mock = transport();
  await assert.rejects(
    generateCandidate(diff, {
      env: { ...repo.env, PATH: repo.cwd, OPENAI_API_KEY: "test-api-key" },
      fetch: mock.fetch,
      temporaryDirectory: repo.cwd,
    }),
    /Could not run Betterleaks/,
  );
  assert.equal(mock.requests.length, 0);
});

test("handles HTTP failures without exposing response bodies or automatically retrying", async (t) => {
  const repo = fixture(t, false);
  for (const status of [400, 401, 404, 429, 500]) {
    const mock = transport({ error: { message: "PRIVATE_INPUT", type: "test_error" } }, status);
    await assert.rejects(
      generateCandidate(diff, {
        env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.doesNotMatch(error.message, /PRIVATE_INPUT|test-api-key/);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  }
});

test("rejects incomplete, missing, malformed, and schema-invalid output", async (t) => {
  const repo = fixture(t, false);
  for (const payload of [
    response("truncated PRIVATE_INPUT", "incomplete"),
    { ...response(), output: [] },
    response("not JSON PRIVATE_INPUT"),
    response(JSON.stringify({ ...candidate, type: 42, description: "PRIVATE_INPUT" })),
  ]) {
    const mock = transport(payload);
    await assert.rejects(
      generateCandidate(diff, {
        env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.doesNotMatch(error.message, /PRIVATE_INPUT/);
        return true;
      },
    );
  }
});

test("handles a model refusal without echoing its contents", async (t) => {
  const repo = fixture(t, false);
  const mock = transport({
    ...response(),
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "PRIVATE_INPUT" }],
      },
    ],
  });
  await assert.rejects(
    generateCandidate(diff, {
      env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
      fetch: mock.fetch,
      temporaryDirectory: repo.cwd,
    }),
    /OpenAI refused/,
  );
});
