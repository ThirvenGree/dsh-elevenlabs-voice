import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ElevenLabs signs upstream connections with SHA256(API key), never the raw key.
export function validUpstreamJwt(raw, key, now = Date.now()) {
  try {
    const parts = String(raw || "")
      .replace(/^Bearer /, "")
      .split(".");
    if (parts.length !== 3 || !key) return false;
    const header = JSON.parse(Buffer.from(parts[0], "base64url"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    const expected = createHmac(
      "sha256",
      createHash("sha256").update(key).digest(),
    )
      .update(parts[0] + "." + parts[1])
      .digest();
    const actual = Buffer.from(parts[2], "base64url");
    return (
      header.alg === "HS256" &&
      expected.length === actual.length &&
      timingSafeEqual(expected, actual) &&
      claims.iss === "https://api.elevenlabs.io/convai/speech-engine" &&
      claims.sub === "convai_speech_engine_upstream" &&
      claims.exp > now / 1000
    );
  } catch {
    return false;
  }
}

// Each upstream signature opens at most one connection before it expires, so a
// relay that sees the header cannot replay it. Keyed by the decoded signature
// bytes: several base64url spellings decode to the same bytes.
export class UpstreamTokenGuard {
  constructor() {
    this.seen = new Map();
  }
  accept(raw, key, now = Date.now()) {
    for (const [signature, exp] of this.seen)
      if (exp <= now / 1000) this.seen.delete(signature);
    if (!validUpstreamJwt(raw, key, now)) return false;
    const parts = String(raw)
        .replace(/^Bearer /, "")
        .split("."),
      signature = Buffer.from(parts[2], "base64url").toString("hex");
    if (this.seen.has(signature)) return false;
    this.seen.set(
      signature,
      JSON.parse(Buffer.from(parts[1], "base64url")).exp,
    );
    return true;
  }
}

export class PetTunnel {
  constructor(dir, port, update) {
    this.dir = dir;
    this.port = port;
    this.update = update;
    this.children = new Set();
    this.closed = false;
  }
  async start() {
    if (
      this.current &&
      Date.now() - this.started < 45 * 60000 &&
      this.current.exitCode === null
    )
      return this.url;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async open() {
    if (this.closed) throw Error("语音服务已关闭");
    mkdirSync(this.dir, { recursive: true });
    const key = path.join(this.dir, "tunnel-ed25519");
    if (!existsSync(key))
      execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"], {
        windowsHide: true,
        stdio: "ignore",
      });
    const child = spawn(
      "ssh",
      [
        "-T",
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-p",
        "443",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "UserKnownHostsFile=" + path.join(this.dir, "known-hosts"),
        "-o",
        "ConnectTimeout=12",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-R",
        "0:127.0.0.1:" + this.port,
        "free@free.pinggy.io",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    const url = await new Promise((resolve, reject) => {
      let output = "",
        done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off("error", bad);
        child.off("exit", bad);
        error ? reject(error) : resolve(value);
      };
      const bad = () => finish(Error("语音隧道连接失败，请重试"));
      const capture = (bytes) => {
        output = (output + bytes.toString()).slice(-20000);
        const found = output.match(
          /https:\/\/[-a-z0-9.]+\.(?:pinggy-free\.link|pinggy\.net|pinggy\.link)/,
        );
        if (found) finish(null, found[0].replace("https:", "wss:"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(Error("语音隧道连接超时"));
      }, 30000);
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", bad);
      child.once("exit", bad);
    }).catch((error) => {
      child.kill();
      throw error;
    });
    if (this.closed) {
      child.kill();
      throw Error("语音服务已关闭");
    }
    const old = this.current;
    try {
      await this.update(url);
    } catch (error) {
      child.kill();
      throw error;
    }
    this.current = child;
    this.url = url;
    this.started = Date.now();
    if (old) {
      const timer = setTimeout(() => old.kill(), 10 * 60000);
      timer.unref();
    }
    return url;
  }
  close() {
    this.closed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
