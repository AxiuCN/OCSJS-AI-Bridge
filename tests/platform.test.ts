/**
 * 跨平台兼容性契约测试。
 *
 * 这些用例专门盯住"Windows 能跑但 Linux 会挂"的高发点：
 * 换行符、路径分隔符、临时目录、URL 拼接、大小写敏感的文件名。
 * 它们在本机（Windows）就执行，回归成本为零。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig, parseConfigDocument } from "../src/config.js";
import { parseEnvFile } from "../src/env.js";
import { parseJsonc } from "../src/jsonc.js";

const workdir = mkdtempSync(join(tmpdir(), "ocs-bridge-test-"));

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const TOKEN = "test-token";

const backend = {
  name: "local",
  kind: "ollama",
  base_url: "http://127.0.0.1:11434",
  model: "qwen3.5:9b",
  capabilities: { vision: true, thinking: true },
};

function configText(newline: string): string {
  return [
    "{",
    `  // 注释行${newline}`,
    '  // 注释里出现 URL 也不该被误当注释起点：https://example.test/x',
    `  "server": { "access_token": "${TOKEN}", "deadline_seconds": 60 },`,
    '  "backends": [',
    `    { "name": "local", "kind": "ollama", "base_url": "http://127.0.0.1:11434", "model": "qwen3.5:9b" }`,
    "  ],",
    '  "routes": [{ "type": "*", "backends": ["local"] }],',
    "}",
  ].join(newline);
}

describe("跨平台：配置文件与换行符", () => {
  it("CRLF 配置（Windows 检出）与 LF 配置解析结果一致", () => {
    const crlfPath = join(workdir, "crlf.jsonc");
    const lfPath = join(workdir, "lf.jsonc");
    writeFileSync(crlfPath, configText("\r\n"), "utf8");
    writeFileSync(lfPath, configText("\n"), "utf8");

    const crlf = loadConfig({ path: crlfPath, envFile: false });
    const lf = loadConfig({ path: lfPath, envFile: false });

    assert.deepEqual(crlf.config.backends, lf.config.backends);
    assert.deepEqual(crlf.config.routes, lf.config.routes);
    assert.equal(crlf.config.server.deadlineSeconds, 60);
    // 注释不该把 CR 带进字段值
    assert.equal(crlf.config.backends[0]?.model, "qwen3.5:9b");
  });

  it("BOM 开头的配置文件也能正常加载（Windows 记事本会写 BOM）", () => {
    const path = join(workdir, "bom.jsonc");
    writeFileSync(path, "\uFEFF" + configText("\n"), "utf8");
    const loaded = loadConfig({ path, envFile: false });
    assert.equal(loaded.config.backends.length, 1);
    assert.equal(loaded.config.backends[0]?.model, "qwen3.5:9b");
  });

  it(".env 支持 LF / CRLF / 混合换行，且值里的空格被正确裁剪", () => {
    for (const newline of ["\n", "\r\n", "\r\n"]) {
      const parsed = parseEnvFile(
        ["# 注释", "A=1", 'B="two words"', "export C=three", "D=four # 尾注"].join(newline),
      );
      assert.deepEqual(parsed, { A: "1", B: "two words", C: "three", D: "four" });
    }
    // Windows 记事本默认 CRLF，且可能带 BOM
    const parsed = parseEnvFile("\uFEFFA=1\r\nB=2\r\n");
    assert.equal(parsed.A, "1");
    assert.equal(parsed.B, "2");
  });
});

describe("跨平台：路径分隔符", () => {
  it("路径可用正斜杠表示（两平台一致）", () => {
    const path = join(workdir, "path-test.jsonc");
    writeFileSync(path, configText("\n"), "utf8");
    const forward = path.split("\\").join("/");
    const loaded = loadConfig({ path: forward, envFile: false });
    assert.equal(loaded.config.backends[0]?.name, "local");
  });

  it("Windows 上反斜杠路径同样可用；Linux 上反斜杠不是分隔符", () => {
    const path = join(workdir, "path-test2.jsonc");
    writeFileSync(path, configText("\n"), "utf8");
    const back = path.split("/").join("\\");
    if (process.platform === "win32") {
      const loaded = loadConfig({ path: back, envFile: false });
      assert.equal(loaded.config.backends[0]?.name, "local");
    } else {
      // Linux 上反斜杠是文件名的合法字符，不应被当成目录分隔符而"意外成功"
      assert.throws(() => loadConfig({ path: back, envFile: false }), /找不到配置文件/);
    }
  });
});

describe("跨平台：URL 与端点拼接", () => {
  const build = (patch: Record<string, unknown>, kind = "ollama"): string => {
    const config = parseConfigDocument(
      {
        server: { access_token: TOKEN, deadline_seconds: 60 },
        backends: [{ ...backend, kind, ...patch, ...(kind === "ollama" ? {} : { api_key: "k" }) }],
        routes: [{ type: "*", backends: ["local"] }],
      },
      [],
    );
    return config.backends[0]!.baseUrl;
  };

  it("base_url 末尾斜杠不影响端点推导", () => {
    assert.equal(build({ base_url: "http://ollama.test:11434" }), "http://ollama.test:11434/api/chat");
    assert.equal(build({ base_url: "http://ollama.test:11434/" }), "http://ollama.test:11434/api/chat");
    assert.equal(build({ base_url: "http://ollama.test:11434/api" }), "http://ollama.test:11434/api/chat");
    assert.equal(
      build({ base_url: "http://ollama.test:11434/api/chat" }),
      "http://ollama.test:11434/api/chat",
      "已写全路径时不重复拼接",
    );
  });

  it("本地回环允许 http，远端必须 https", () => {
    assert.equal(build({ base_url: "http://127.0.0.1:11434" }), "http://127.0.0.1:11434/api/chat");
    assert.equal(build({ base_url: "http://localhost:11434" }), "http://localhost:11434/api/chat");
    assert.equal(
      build({ base_url: "https://api.example.test" }, "openai_chat"),
      "https://api.example.test/v1/chat/completions",
    );
    assert.throws(() => build({ base_url: "http://api.example.test" }, "openai_chat"), /https/);
  });
});

describe("跨平台：部署文件的行尾", () => {
  const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

  it("Windows 批处理必须是 CRLF（LF 会让 cmd 解析异常）", () => {
    const text = read("deploy/start.bat");
    assert.ok(text.includes("\r\n"), "start.bat 应使用 CRLF 行尾");
    // 不允许出现裸 LF：要么是 CRLF 的组成部分，要么不存在
    assert.ok(!/(^|[^\r])\n/.test(text), "start.bat 不应含裸 LF");
  });

  it("systemd 单元必须是 LF（CRLF 会让 systemd 解析失败）", () => {
    const text = read("deploy/ocs-ai-bridge.service");
    assert.ok(!text.includes("\r"), "ocs-ai-bridge.service 不应含 CR");
    assert.ok(text.includes("\n"), "ocs-ai-bridge.service 应有 LF 换行");
  });

  it("已声明 .gitattributes 行尾策略，避免跨平台检出差异", () => {
    const text = read(".gitattributes");
    assert.match(text, /\*\.bat text eol=crlf/u);
    assert.match(text, /text=auto eol=lf/u);
  });

  it("仓库内的文本文件不含 NUL 等损坏字符", () => {
    // 这类字符通常由编码不当的写回引入，肉眼不可见却会让文档/配置损坏。
    const roots = ["src", "tests", "scripts", "deploy"];
    const rootFiles = [
      "README.md",
      "ACCEPTANCE.md",
      "config.example.jsonc",
      ".env.example",
      "ocs-answerer-wrapper.json.example",
      "package.json",
      "tsconfig.json",
      "tsconfig.test.json",
      ".gitattributes",
    ];
    const targets: string[] = [...rootFiles];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else targets.push(full);
      }
    };
    for (const dir of roots) walk(dir);

    const damaged: string[] = [];
    for (const relative of targets) {
      try {
        const content = readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
        if (content.includes("\u0000")) damaged.push(relative);
      } catch {
        // 文件不存在（例如某些本地文件）时跳过
      }
    }
    assert.deepEqual(damaged, [], `以下文件含 NUL 字节：${damaged.join(", ")}`);
  });
});

describe("跨平台：临时目录与文件名", () => {
  it("临时目录路径（Windows 含反斜杠）可用作配置路径", () => {
    const path = join(tmpdir(), `ocs-bridge-${process.pid}-${Date.now()}.jsonc`);
    writeFileSync(path, configText("\n"), "utf8");
    try {
      const loaded = loadConfig({ path, envFile: false });
      assert.equal(loaded.config.backends.length, 1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("JSONC 解析不依赖平台换行，也不误伤 URL 里的双斜杠", () => {
    const parsed = parseJsonc('{\r\n  // https://example.test/comment\r\n  "url": "https://example.test/v1",\r\n}');
    assert.deepEqual(parsed, { url: "https://example.test/v1" });
  });
});
