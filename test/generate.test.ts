import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL,
  generateCandidate,
  GenerationError,
  resolveGenerationSettings,
} from "../src/generate.ts";
import { assembleCommitMessage, validateCommitMessage } from "../src/message.ts";
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

function anthropicResponse(text = JSON.stringify(candidate), stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const providers = ["openai", "anthropic"] as const;
const credentials = { OPENAI_API_KEY: "test-openai-key", ANTHROPIC_API_KEY: "test-anthropic-key" };

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
  assert.match(body.instructions, /candidate in English/);
});

test("validates provider, language, and model without choosing an implicit Anthropic model", () => {
  assert.deepEqual(resolveGenerationSettings(), {
    provider: "openai",
    language: "en",
    model: DEFAULT_MODEL,
  });
  for (const options of [
    { provider: "PRIVATE_INPUT" },
    { language: "PRIVATE_INPUT" },
    { model: " " },
    { model: " PRIVATE_INPUT " },
    { provider: "anthropic" },
  ]) {
    assert.throws(
      () => resolveGenerationSettings(options),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.doesNotMatch(error.message, /PRIVATE_INPUT/);
        return true;
      },
    );
  }
});

test("Anthropic uses Messages, a fixed endpoint, and the same structured candidate with its own key", async (t) => {
  const repo = fixture(t, false);
  const mock = transport(anthropicResponse());
  const result = await generateCandidate(diff, {
    provider: "anthropic",
    model: "claude-test-model",
    env: { ...repo.env, ANTHROPIC_API_KEY: credentials.ANTHROPIC_API_KEY },
    fetch: mock.fetch,
    temporaryDirectory: repo.cwd,
  });
  assert.deepEqual(result, candidate);
  assert.equal(mock.requests.length, 1);
  const request = mock.requests[0]!;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers.get("authorization"), `Bearer ${credentials.ANTHROPIC_API_KEY}`);
  const body = JSON.parse(await request.text());
  assert.equal(body.model, "claude-test-model");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.store, undefined, "store is an OpenAI parameter");
  assert.deepEqual(body.messages, [{ role: "user", content: JSON.stringify({ diff }) }]);
  assert.ok(!body.system.includes(diff));
  assert.match(body.system, /untrusted data/);
  assert.match(body.system, /candidate in English/);
});

test("both providers generate and regenerate Japanese messages while preserving Conventional Commit tokens", async (t) => {
  const repo = fixture(t, false);
  const japanese = {
    ...candidate,
    description: "ステージ済みの差分の読み取りを追加",
    body: "作業ツリーを変更せずに差分を取得する。\n\n部分ステージにも対応する。",
    breaking: true,
    breakingDescription: "旧形式の設定を新形式へ移行してください。",
    footers: [{ token: "Refs", separator: ":", value: "#123" }],
  };
  for (const provider of providers) {
    for (const previousCandidate of [undefined, "feat: read staged changes"]) {
      const mock = transport(
        provider === "openai"
          ? response(JSON.stringify(japanese))
          : anthropicResponse(JSON.stringify(japanese)),
      );
      const result = await generateCandidate(diff, {
        provider,
        language: "ja",
        model: "structured-output-model",
        ...(previousCandidate === undefined ? {} : { previousCandidate }),
        env: { ...repo.env, ...credentials },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      });
      const body = JSON.parse(await mock.requests[0]!.text());
      const instructions = provider === "openai" ? body.instructions : body.system;
      const input = provider === "openai" ? body.input[0].content : body.messages[0].content;
      assert.match(instructions, /candidate in Japanese/);
      assert.match(instructions, /type and footer tokens in English/);
      assert.match(instructions, /including when regenerating/);
      assert.deepEqual(JSON.parse(input), {
        diff,
        ...(previousCandidate === undefined ? {} : { previousCandidate }),
      });
      const message = assembleCommitMessage(result);
      assert.ok(message.startsWith(`feat(cli)!: ${japanese.description}`));
      assert.ok(message.includes(`BREAKING CHANGE: ${japanese.breakingDescription}`));
      assert.equal(validateCommitMessage(message).body, japanese.body);
    }
  }
});

test("Anthropic ignores SDK endpoint, credential-profile, and logging environment overrides", async (t) => {
  const repo = fixture(t, false);
  const overrides = {
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "unused-auth-token",
    ANTHROPIC_PROFILE: "nonexistent-profile",
    ANTHROPIC_LOG: "debug",
  };
  for (const [key, value] of Object.entries(overrides)) {
    const old = process.env[key];
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
    process.env[key] = value;
  }
  const debug = t.mock.method(console, "debug", () => {});
  const log = t.mock.method(console, "log", () => {});
  const mock = transport(anthropicResponse());
  await generateCandidate(diff, {
    provider: "anthropic",
    model: "claude-test-model",
    env: { ...repo.env, ...credentials },
    fetch: mock.fetch,
    temporaryDirectory: repo.cwd,
  });
  assert.equal(mock.requests[0]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(
    mock.requests[0]?.headers.get("authorization"),
    `Bearer ${credentials.ANTHROPIC_API_KEY}`,
  );
  assert.equal(debug.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 0);
});

test("Anthropic requires its runtime key even if an OpenAI key is present", async () => {
  const mock = transport();
  await assert.rejects(
    generateCandidate(diff, {
      provider: "anthropic",
      model: "claude-test-model",
      env: { OPENAI_API_KEY: credentials.OPENAI_API_KEY },
      fetch: mock.fetch,
    }),
    /ANTHROPIC_API_KEY is not set/,
  );
  assert.equal(mock.requests.length, 0);
});

test("both providers block either runtime key in the diff or previous candidate before scanning or sending", async () => {
  for (const provider of providers) {
    for (const key of Object.values(credentials)) {
      for (const location of ["diff", "previousCandidate"]) {
        const mock = transport();
        await assert.rejects(
          generateCandidate(location === "diff" ? `+${key}` : diff, {
            provider,
            model: "structured-output-model",
            previousCandidate:
              location === "previousCandidate" ? `fix: ${key}` : "fix: ordinary candidate",
            env: credentials,
            fetch: mock.fetch,
          }),
          /API key occurs/,
        );
        assert.equal(mock.requests.length, 0);
      }
    }
  }
});

test("Anthropic blocks oversized input and scanner failures before sending", async (t) => {
  const repo = fixture(t, false);
  for (const scenario of [
    { maxInputBytes: 20, error: /encoded input exceeds/ },
    { maxInputBytes: 1048576, error: /Could not run Betterleaks/ },
  ]) {
    const mock = transport();
    await assert.rejects(
      generateCandidate(diff, {
        provider: "anthropic",
        model: "claude-test-model",
        maxInputBytes: scenario.maxInputBytes,
        env: { ...repo.env, ...credentials, PATH: repo.cwd },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      scenario.error,
    );
    assert.equal(mock.requests.length, 0);
  }
});

test("Anthropic handles HTTP errors without leaking bodies, retrying, or falling back to OpenAI", async (t) => {
  const repo = fixture(t, false);
  for (const status of [400, 401, 403, 404, 429, 500, 529]) {
    const mock = transport(
      { type: "error", error: { type: "test_error", message: "PRIVATE_INPUT" } },
      status,
    );
    await assert.rejects(
      generateCandidate(diff, {
        provider: "anthropic",
        model: "claude-test-model",
        env: { ...repo.env, ...credentials },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.match(error.message, /Anthropic/);
        assert.doesNotMatch(error.message, /PRIVATE_INPUT|test-anthropic-key|test-openai-key/);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.url, "https://api.anthropic.com/v1/messages");
  }
});

test("Anthropic rejects refusals, truncation, missing content, malformed JSON, and invalid schemas", async (t) => {
  const repo = fixture(t, false);
  for (const scenario of [
    { payload: anthropicResponse("PRIVATE_INPUT", "refusal"), error: /Anthropic refused/ },
    ...["max_tokens", "model_context_window_exceeded", "pause_turn", "tool_use"].map((reason) => ({
      payload: anthropicResponse("PRIVATE_INPUT", reason),
      error: /did not complete/,
    })),
    {
      payload: anthropicResponse(JSON.stringify(candidate), "max_tokens"),
      error: /did not complete/,
    },
    { payload: { ...anthropicResponse(), content: [] }, error: /structured commit candidate/ },
    { payload: anthropicResponse("PRIVATE_INPUT"), error: /invalid response/ },
    {
      payload: anthropicResponse(
        JSON.stringify({ ...candidate, type: 42, description: "PRIVATE_INPUT" }),
      ),
      error: /invalid response/,
    },
  ]) {
    const mock = transport(scenario.payload);
    await assert.rejects(
      generateCandidate(diff, {
        provider: "anthropic",
        model: "claude-test-model",
        env: { ...repo.env, ...credentials },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.match(error.message, scenario.error);
        assert.doesNotMatch(error.message, /PRIVATE_INPUT/);
        return true;
      },
    );
  }
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

test("both providers scan removed and context lines as well as additions before sending", async (t) => {
  const repo = fixture(t, false);
  // Synthetic detector fixture, assembled to avoid committing a credential-shaped literal.
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  for (const provider of providers) {
    for (const prefix of ["+", "-", " "]) {
      const mock = transport();
      await assert.rejects(
        generateCandidate(`${prefix}token = "${token}"\n`, {
          provider,
          model: "structured-output-model",
          env: { ...repo.env, ...credentials },
          fetch: mock.fetch,
          temporaryDirectory: repo.cwd,
        }),
        SecretScanError,
      );
      assert.equal(mock.requests.length, 0);
    }
  }
});

test("both providers scan the previous candidate before regeneration", async (t) => {
  const repo = fixture(t, false);
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  for (const provider of providers) {
    const mock = transport();
    await assert.rejects(
      generateCandidate(diff, {
        provider,
        model: "structured-output-model",
        previousCandidate: `fix: replace token ${token}`,
        env: { ...repo.env, ...credentials },
        fetch: mock.fetch,
        temporaryDirectory: repo.cwd,
      }),
      SecretScanError,
    );
    assert.equal(mock.requests.length, 0);
  }
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
