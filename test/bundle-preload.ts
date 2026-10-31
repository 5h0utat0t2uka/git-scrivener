// Loaded only by the bundle integration tests via Node's --import option.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });

const requests: { url: string; body: unknown }[] = [];
globalThis.fetch = async (url, init) => {
  const request = new Request(url, init);
  assert.ok(
    request.url === "https://api.openai.com/v1/responses" ||
      request.url === "https://api.anthropic.com/v1/messages",
  );
  assert.equal(request.method, "POST");
  const body = (await request.json()) as { model: string; instructions?: string; system?: string };
  requests.push({ url: request.url, body });
  writeFileSync("requests.json", JSON.stringify(requests));
  const status = Number(process.env.SCRIVENER_TEST_HTTP_STATUS ?? "200");
  if (status !== 200) {
    return Response.json({ error: { message: "PRIVATE_RESPONSE_DATA" } }, { status });
  }
  const japanese = (body.instructions ?? body.system ?? "").includes("candidate in Japanese");
  const text = JSON.stringify({
    type: "feat",
    scope: "cli",
    description: japanese ? "ステージ済みの変更を追加" : "add staged changes",
    body: requests.length > 1 ? "Regenerated candidate." : null,
    breaking: false,
    breakingDescription: null,
    footers: [],
  });
  if (request.url === "https://api.anthropic.com/v1/messages") {
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [
        { type: "thinking", thinking: "PRIVATE_THINKING_DATA", signature: "test-signature" },
        { type: "text", text },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  return Response.json({
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  });
};
