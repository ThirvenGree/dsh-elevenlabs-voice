import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { defaults, validateConfig } from "./shared.js";
import { VoiceCore, VoiceError } from "./core.js";
export const name = "elevenlabs-voice";
export const inject = ["webServer"];
export function guard(req, token) {
  const fail = () => {
    throw new VoiceError("forbidden", "仅允许 DSH 本机页面操作", 403);
  };
  let u;
  try {
    u = new URL("http://" + req.headers.host);
  } catch {
    fail();
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.host !== req.headers.host ||
    u.username ||
    u.password ||
    (req.socket?.localPort && Number(u.port || 80) !== req.socket.localPort)
  )
    fail();
  if (
    req.socket?.remoteAddress &&
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  )
    fail();
  if (req.headers["sec-fetch-site"] === "cross-site") fail();
  if (req.headers.origin && req.headers.origin !== "http://" + u.host) fail();
  if (req.method !== "GET") {
    const t = req.headers["x-elevenlabs-csrf"];
    if (
      typeof t !== "string" ||
      Buffer.byteLength(t) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(t), Buffer.from(token))
    )
      fail();
  }
}
export async function readBody(req, max = 32 * 1024 * 1024) {
  const parts = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > max) throw new VoiceError("too_large", "请求内容过大", 413);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export function apply(ctx) {
  const dir = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
    "elevenlabs-voice",
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  let config = { ...defaults };
  try {
    config = validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {}
  const core = new VoiceCore({ config: () => config }),
    token = randomBytes(32).toString("hex");
  let active = 0;
  const json = (res, status, value) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  ctx.effect(() => () => {
    void core.close();
  });
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: "/dsh-elevenlabs-voice",
      handler: async (req, res) => {
        const controller = new AbortController(),
          onClose = () => {
            if (!res.writableEnded) controller.abort();
          };
        res.on("close", onClose);
        try {
          guard(req, token);
          const route = new URL(req.url, "http://localhost").pathname.replace(
            /^\/dsh-elevenlabs-voice/,
            "",
          );
          if (route === "/state" && req.method === "GET")
            return json(res, 200, {
              ok: true,
              config,
              keyPresent: Boolean(process.env.ELEVENLABS_API_KEY),
              csrfToken: token,
              receipts: core.receipts,
              capabilities: { petVoice: false, phase: 1 },
            });
          if (route === "/config" && req.method === "PUT") {
            const next = validateConfig(
              JSON.parse((await readBody(req, 65536)).toString()),
            );
            fs.writeFileSync(file + ".tmp", JSON.stringify(next, null, 2));
            fs.renameSync(file + ".tmp", file);
            config = next;
            core.abort();
            return json(res, 200, { ok: true, config });
          }
          if (req.method !== "POST")
            return json(res, 405, { ok: false, error: "不支持的方法" });
          if (active >= 3)
            throw new VoiceError("busy", "语音请求繁忙，请稍后再试", 429);
          active++;
          try {
            if (route === "/connection")
              return json(res, 200, await core.connection(controller.signal));
            if (route === "/transcribe") {
              const data = await readBody(req);
              return json(res, 200, {
                ok: true,
                ...(await core.transcribe(
                  data,
                  String(req.headers["content-type"] || ""),
                  controller.signal,
                )),
              });
            }
            if (route === "/tts") {
              const { text } = JSON.parse(
                (await readBody(req, 65536)).toString(),
              );
              const result = await core.synthesize(text, controller.signal);
              res.writeHead(200, {
                "content-type": "audio/mpeg",
                "cache-control": "no-store",
                "x-elevenlabs-request-id": result.receipt.requestId || "",
                "x-elevenlabs-requested-model":
                  result.receipt.requestedModel || "",
              });
              return res.end(result.data);
            }
            return json(res, 404, { ok: false, error: "接口不存在" });
          } finally {
            active--;
          }
        } catch (e) {
          if (!res.destroyed && !res.writableEnded)
            json(res, e instanceof VoiceError ? e.status : 400, {
              ok: false,
              kind: e.kind || "request",
              error: e instanceof VoiceError ? e.message : "配置或请求格式无效",
            });
        } finally {
          res.off("close", onClose);
        }
      },
    }),
  );
  // Native registry is optional. Custom UI uses the same core because it must capture
  // the caret at transcription completion rather than at recording start.
  ctx.inject(["speechToText"], (scope) =>
    scope.effect(() =>
      scope.speechToText.register({
        info: {
          id: "elevenlabs-voice",
          name: "ElevenLabs Scribe",
          languages: ["auto", "zh", "en"],
        },
        async transcribe({ audio }, signal) {
          return core.transcribe(audio, "audio/wav", signal);
        },
      }),
    ),
  );
}
