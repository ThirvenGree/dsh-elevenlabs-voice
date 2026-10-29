import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { fetch, ProxyAgent } from "undici";
import { VoiceCore, providerError } from "./core.js";
import { PetTunnel, validUpstreamJwt } from "./pet-tunnel.js";
import { petConfig, canSpeakAutomatically } from "./pet-config.js";
import { parsePetTask, withoutPetTask } from "./pet-tasks.js";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
const nonce = () => randomBytes(24).toString("hex");
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const body = async (req) => {
  let data = "";
  for await (const bytes of req) {
    data += bytes.toString();
    if (data.length > 32000) throw Error("请求过大");
  }
  return data ? JSON.parse(data) : {};
};
export class PetVoiceHost {
  constructor(ctx, dir, config) {
    this.ctx = ctx;
    this.dir = dir;
    this.config = config;
    this.tokens = new Map();
    this.sockets = new Map();
    this.jobs = new Map();
    this.engines = new Map();
    this.cores = new Map();
    this.counters = new Map();
    this.rates = new Map();
    this.routes = new Map();
    this.closed = false;
    this.upstreamOwners = new Map();
    this.taskOffers = new Map();
    this.timers = new Set();
    this.cache = new Map();
    this.startingSessions = new Map();
    this.remoteFile = path.join(dir, "pet-engines.json");
    try {
      for (const [id, engine] of Object.entries(
        JSON.parse(fs.readFileSync(this.remoteFile, "utf8")),
      )) {
        if (typeof engine.id === "string" && typeof engine.route === "string") {
          this.engines.set(id, engine);
          this.routes.set(engine.route, id);
        }
      }
    } catch {}
    this.file = path.join(dir, "pet.json");
    this.saved = {};
    try {
      this.saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    this.upstream = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256000 });
    this.upstream.on("upgrade", (req, socket, head) => {
      const petId = this.routes.get(req.url);
      if (
        !petId ||
        !this.sockets.has(petId) ||
        !validUpstreamJwt(
          req.headers["x-elevenlabs-speech-engine-authorization"],
          process.env.ELEVENLABS_API_KEY,
        )
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.connectUpstream(petId, ws),
      );
    });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.uiWs = new WebSocketServer({ noServer: true, maxPayload: 32000 });
    this.server.on("upgrade", (req, socket, head) => {
      const token = new URL(req.url, "http://local").pathname.split("/")[2],
        entry = this.tokens.get(token);
      if (!entry || entry.expires < Date.now() || !this.local(req)) {
        socket.destroy();
        return;
      }
      this.uiWs.handleUpgrade(req, socket, head, (ws) =>
        this.connectUi(entry.petId, ws),
      );
    });
    this.ready = Promise.all([listen(this.upstream), listen(this.server)]).then(
      ([port, uiPort]) => {
        this.port = uiPort;
        this.tunnel = new PetTunnel(
          path.join(dir, "tunnel"),
          port,
          async (url) => {
            for (const [id, engine] of this.engines)
              await this.updateEngine(id, engine, url);
          },
        );
      },
    );
    this.interval = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.interval.unref();
  }
  bridge() {
    const service = this.ctx.get?.("petVoiceBridge7340");
    if (!service) throw Error("请更新并启用 dsh-pet 桌宠插件");
    return service;
  }
  settings(id) {
    return petConfig(this.saved[id] || {});
  }
  persistEngines() {
    fs.writeFileSync(
      this.remoteFile + ".tmp",
      JSON.stringify(Object.fromEntries(this.engines), null, 2),
    );
    fs.renameSync(this.remoteFile + ".tmp", this.remoteFile);
  }
  configurationChanged() {
    if (!this.config().enabled) {
      for (const id of this.sockets.keys()) {
        this.stop(id);
        this.send(id, { type: "disabled" });
      }
    }
  }
  persist() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.saved, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  async panel(petId) {
    await this.ready;
    this.bridge().describe(petId);
    for (const [key, value] of this.tokens)
      if (value.expires < Date.now()) this.tokens.delete(key);
    const token = nonce();
    this.tokens.set(token, { petId, expires: Date.now() + 24 * 3600000 });
    return { url: `http://127.0.0.1:${this.port}/pet/${token}/` };
  }
  local(req) {
    return (
      req.headers.host === `127.0.0.1:${this.port}` &&
      ["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
      (!req.headers.origin ||
        req.headers.origin === `http://127.0.0.1:${this.port}`)
    );
  }
  send(id, data) {
    const ws = this.sockets.get(id);
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  }
  core(id) {
    if (!this.cores.has(id))
      this.cores.set(
        id,
        new VoiceCore({
          config: () => {
            const root = this.config(),
              c = this.settings(id);
            return {
              ...root,
              enabled: root.enabled && c.enabled,
              dshEnabled: true,
              sttEnabled: true,
              playbackEnabled: true,
              ttsModel: c.ttsModel,
              voiceId: c.voiceId || root.voiceId,
              volume: c.volume,
            };
          },
        }),
      );
    return this.cores.get(id);
  }
  async api(route, method = "GET", data) {
    if (!process.env.ELEVENLABS_API_KEY)
      throw Error("未找到 ELEVENLABS_API_KEY，设置后请重启 DSH");
    const proxy = this.config().proxy;
    if (proxy !== this.proxyUrl) {
      await this.proxy?.close();
      this.proxy = proxy ? new ProxyAgent(proxy) : null;
      this.proxyUrl = proxy;
    }
    const res = await fetch("https://api.elevenlabs.io/v1" + route, {
      method,
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        ...(data ? { "content-type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      ...(this.proxy ? { dispatcher: this.proxy } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 204) return {};
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw providerError(res.status, result);
    return result;
  }
  engineBody(id, url, engine) {
    const c = this.settings(id);
    return {
      name: "DSH Pet " + id,
      speech_engine: { ws_url: url + engine.route },
      tts: {
        model_id: c.ttsModel,
        voice_id: c.voiceId || this.config().voiceId,
      },
      language: "zh",
      privacy: { record_voice: false },
      conversation: { max_duration_seconds: 600 },
      call_limits: { agent_concurrency_limit: 1, daily_limit: 100 },
    };
  }
  async updateEngine(id, engine, url) {
    await this.api(
      "/speech-engine/" + encodeURIComponent(engine.id),
      "PATCH",
      this.engineBody(id, url, engine),
    );
  }
  async signed(id) {
    if (this.startingSessions.has(id)) return this.startingSessions.get(id);
    const pending = this.createSession(id).finally(() =>
      this.startingSessions.delete(id),
    );
    this.startingSessions.set(id, pending);
    return pending;
  }
  async createSession(id) {
    if (!this.sockets.has(id)) throw Error("语音面板未连接，请重新打开");
    if (!this.config().enabled || !this.settings(id).enabled)
      throw Error("桌宠语音已关闭");
    if (!(this.settings(id).voiceId || this.config().voiceId))
      throw Error("请先填写 Voice ID");
    const url = await this.tunnel.start();
    if (!this.sockets.has(id) || this.closed) throw Error("语音会话已取消");
    let engine = this.engines.get(id);
    if (!engine) {
      engine = { route: "/upstream/" + nonce() };
      this.routes.set(engine.route, id);
      try {
        const result = await this.api(
          "/speech-engine",
          "POST",
          this.engineBody(id, url, engine),
        );
        engine.id = result.speech_engine_id || result.engine_id;
        if (!engine.id) throw Error("语音引擎创建失败");
        this.engines.set(id, engine);
        this.persistEngines();
      } catch (error) {
        this.routes.delete(engine.route);
        throw error;
      }
    } else await this.updateEngine(id, engine, url);
    const signed = await this.api(
      "/convai/conversation/get-signed-url?agent_id=" +
        encodeURIComponent(engine.id),
    );
    return { signedUrl: signed.signed_url };
  }
  connectUi(id, ws) {
    this.sockets.get(id)?.close(4001, "已在另一端打开语音");
    this.stop(id);
    this.sockets.set(id, ws);
    ws.on("message", (bytes) => {
      try {
        const m = JSON.parse(bytes);
        if (m.type === "speaking")
          this.bridge().speaking(id, m.active === true);
        if (m.type === "stop") this.stop(id);
      } catch {}
    });
    ws.on("close", () => {
      if (this.sockets.get(id) === ws) {
        this.sockets.delete(id);
        this.stop(id);
      }
    });
  }
  stop(id) {
    this.jobs.get(id)?.abort();
    this.jobs.delete(id);
    this.cores.get(id)?.abort();
    try {
      this.bridge().speaking(id, false);
    } catch {}
    for (const ws of this.wss.clients) if (ws.petId === id) ws.close();
  }
  connectUpstream(id, ws) {
    this.upstreamOwners.get(id)?.close();
    this.upstreamOwners.set(id, ws);
    ws.petId = id;
    let event = -1;
    ws.on("message", (bytes) => {
      let m;
      try {
        m = JSON.parse(bytes);
      } catch {
        return;
      }
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (m.type !== "user_transcript") return;
      const list = Array.isArray(m.user_transcript) ? m.user_transcript : [],
        last = [...list].reverse().find((x) => x.role === "user");
      if (!last?.content || !Number.isFinite(m.event_id) || m.event_id <= event)
        return;
      event = m.event_id;
      const current = event;
      void this.reply(id, String(last.content).slice(0, 12000), (delta) => {
        if (ws.readyState === 1 && current === event)
          ws.send(
            JSON.stringify({
              type: "agent_response",
              event_id: current,
              content: delta,
              is_final: false,
            }),
          );
      })
        .then(() => {
          if (ws.readyState === 1 && current === event)
            ws.send(
              JSON.stringify({
                type: "agent_response",
                event_id: current,
                content: "",
                is_final: true,
              }),
            );
        })
        .catch((error) => {
          if (current === event && !this.closed) {
            this.send(id, { type: "error", error: error.message });
            if (ws.readyState === 1)
              ws.send(
                JSON.stringify({
                  type: "agent_response",
                  event_id: current,
                  content: "",
                  is_final: true,
                }),
              );
          }
        });
    });
    ws.on("close", () => {
      if (this.upstreamOwners.get(id) !== ws) return;
      this.upstreamOwners.delete(id);
      this.jobs.get(id)?.abort();
      try {
        this.bridge().speaking(id, false);
      } catch {}
    });
  }
  async reply(id, text, emit, external) {
    if (!this.config().enabled || !this.settings(id).enabled)
      throw Error("桌宠语音已关闭");
    this.jobs.get(id)?.abort();
    const controller = new AbortController();
    this.jobs.set(id, controller);
    const signal = external
      ? AbortSignal.any([controller.signal, external])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      this.send(id, { type: "user", text });
      let result = "",
        buffer = "";
      const c = this.settings(id);
      for await (const delta of this.bridge().stream(
        id,
        text,
        signal,
        c.provider ? { provider: c.provider, model: c.model } : undefined,
      )) {
        signal.throwIfAborted();
        result += delta;
        buffer += delta;
        const index = buffer.indexOf("<pet-task>");
        const length = index >= 0 ? index : Math.max(0, buffer.length - 10);
        if (length) {
          const visible = buffer.slice(0, length);
          buffer = buffer.slice(length);
          emit(visible);
          this.send(id, { type: "delta", text: visible });
        }
      }
      const tail = buffer.replace(/<pet-task>[\s\S]*?(?:<\/pet-task>|$)/g, "");
      if (tail) {
        emit(tail);
        this.send(id, { type: "delta", text: tail });
      }
      const task = parsePetTask(result);
      if (task) {
        const taskId = nonce();
        this.taskOffers.set(taskId, {
          petId: id,
          task,
          expires: Date.now() + 300000,
        });
        this.send(id, { type: "task", taskId, task });
      }
      const clean = withoutPetTask(result);
      this.send(id, { type: "done", text: clean });
      return clean;
    } finally {
      clearTimeout(timer);
      if (this.jobs.get(id) === controller) this.jobs.delete(id);
    }
  }
  async handle(req, res) {
    try {
      await this.ready;
      if (!this.local(req))
        return json(res, { error: "仅允许本机语音页面" }, 403);
      const url = new URL(req.url, "http://local"),
        parts = url.pathname.split("/"),
        token = parts[2],
        entry = this.tokens.get(token),
        route = parts[3] || "";
      if (parts[1] !== "pet" || !entry || entry.expires < Date.now())
        return json(res, { error: "面板已过期，请从 Pet 重新打开" }, 403);
      if (req.method !== "GET" && req.headers["x-pet-token"] !== token)
        return json(res, { error: "请求验证失败" }, 403);
      const id = entry.petId;
      if (req.method === "GET" && route === "") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "permissions-policy": "microphone=(self)",
          "content-security-policy":
            "default-src 'self'; script-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https://api.elevenlabs.io; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:",
        });
        return res.end(fs.readFileSync(new URL("./pet.html", import.meta.url)));
      }
      if (req.method === "GET" && route === "client.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(
          fs.readFileSync(new URL("../lib/pet-client.js", import.meta.url)),
        );
      }
      if (req.method === "GET" && route === "state")
        return json(res, {
          petId: id,
          settings: this.settings(id),
          model: this.settings(id).provider
            ? {
                provider: this.settings(id).provider,
                model: this.settings(id).model,
              }
            : this.bridge().describe(id).model,
          history: (await this.bridge().history(id)).slice(-60),
          lastLine:
            this.bridge()
              .events()
              .find((e) => e.petId === id)?.data?.text || "",
          keyPresent: !!process.env.ELEVENLABS_API_KEY,
        });
      if (req.method !== "POST") return json(res, { error: "接口不存在" }, 404);
      const data = await body(req);
      if (route === "settings") {
        this.saved[id] = petConfig(data);
        this.persist();
        this.stop(id);
        return json(res, { ok: true });
      }
      if (route === "session") return json(res, await this.signed(id));
      if (route === "stop") {
        this.stop(id);
        return json(res, { ok: true });
      }
      if (route === "task") {
        const offer = this.taskOffers.get(data.taskId);
        if (!offer || offer.petId !== id || offer.expires < Date.now())
          throw Error("任务提议已过期");
        this.taskOffers.delete(data.taskId);
        if (offer.task.type === "url")
          return json(res, { url: offer.task.url });
        const task = offer.task,
          timer = setTimeout(() => {
            this.timers.delete(timer);
            try {
              this.bridge().say(id, "计时结束：" + task.label);
            } catch {}
            this.send(id, { type: "speak", text: "计时结束：" + task.label });
          }, task.seconds * 1000);
        timer.unref();
        this.timers.add(timer);
        return json(res, { ok: true });
      }
      if (route === "clear") {
        this.stop(id);
        await this.bridge().clear(id);
        return json(res, { ok: true });
      }
      if (route === "chat") {
        if (
          typeof data.text !== "string" ||
          !data.text.trim() ||
          data.text.length > 12000
        )
          throw Error("请输入 1–12000 字");
        const controller = new AbortController();
        const close = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once("close", close);
        try {
          return json(res, {
            text: await this.reply(id, data.text, () => {}, controller.signal),
          });
        } finally {
          res.off("close", close);
        }
      }
      if (route === "tts") {
        if (!this.config().enabled || !this.settings(id).enabled)
          throw Error("桌宠语音已关闭");
        if (
          typeof data.text !== "string" ||
          !data.text.trim() ||
          data.text.length > 2400
        )
          throw Error("每次朗读 1–2400 字");
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        const c = this.settings(id),
          key = JSON.stringify([
            data.text,
            c.voiceId || this.config().voiceId,
            c.ttsModel,
          ]);
        let audio = this.cache.get(key);
        if (!audio) {
          audio = await this.core(id).synthesize(data.text, controller.signal);
          this.cache.set(key, audio);
          while (this.cache.size > 24)
            this.cache.delete(this.cache.keys().next().value);
        }
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
          "x-elevenlabs-requested-model": audio.receipt.requestedModel || "",
        });
        return res.end(audio.data);
      }
      return json(res, { error: "接口不存在" }, 404);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded)
        json(
          res,
          {
            error:
              error.name === "AbortError"
                ? "已取消"
                : error.message || "语音操作失败",
          },
          error.status || 400,
        );
    }
  }
  async tick() {
    if (this.closed) return;
    if (
      this.tunnel?.current &&
      this.sockets.size &&
      Date.now() > (this.tunnelRetry || 0) &&
      (Date.now() - this.tunnel.started > 45 * 60000 ||
        this.tunnel.current.exitCode !== null)
    ) {
      this.tunnelRetry = Date.now() + 60000;
      void this.tunnel.start().catch((error) => {
        for (const id of this.sockets.keys())
          this.send(id, { type: "error", error: error.message });
      });
    }
    let events;
    try {
      events = this.bridge().events();
    } catch {
      return;
    }
    for (const [taskId, offer] of this.taskOffers)
      if (offer.expires < Date.now()) this.taskOffers.delete(taskId);
    for (const event of events) {
      const previous = this.counters.get(event.petId);
      this.counters.set(event.petId, event.counter);
      if (
        previous === undefined ||
        previous === event.counter ||
        event.data?.voiceProduced ||
        !event.data?.text ||
        !this.sockets.has(event.petId) ||
        this.jobs.has(event.petId)
      )
        continue;
      const c = this.settings(event.petId),
        recent = this.rates.get(event.petId) || [];
      if (!canSpeakAutomatically(c, recent)) continue;
      recent.push(Date.now());
      this.rates.set(
        event.petId,
        recent.filter((t) => Date.now() - t < 3600000),
      );
      this.send(event.petId, {
        type: "speak",
        text: String(event.data.text).slice(0, 2400),
      });
    }
    if (!this.sockets.size && this.tunnel?.current) {
      this.idleSince ??= Date.now();
      if (Date.now() - this.idleSince > 60000) {
        this.tunnel.close();
        this.tunnel = new PetTunnel(
          path.join(this.dir, "tunnel"),
          this.upstream.address().port,
          async (url) => {
            for (const [id, engine] of this.engines)
              await this.updateEngine(id, engine, url);
          },
        );
      }
    } else this.idleSince = null;
  }
  async close() {
    this.closed = true;
    clearInterval(this.interval);
    for (const timer of this.timers) clearTimeout(timer);
    for (const id of this.sockets.keys()) this.stop(id);
    for (const ws of this.uiWs.clients) ws.terminate();
    for (const ws of this.wss.clients) ws.terminate();
    this.tunnel?.close();
    await Promise.allSettled(
      [...this.cores.values()].map((core) => core.close()),
    );
    await Promise.allSettled(
      [...this.engines.entries()].map(async ([id, engine]) => {
        await this.api(
          "/speech-engine/" + encodeURIComponent(engine.id),
          "DELETE",
        );
        this.engines.delete(id);
      }),
    );
    this.persistEngines();
    this.uiWs.close();
    this.wss.close();
    this.server.close();
    this.upstream.close();
    await this.proxy?.close();
  }
}
