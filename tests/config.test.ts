/**
 * 配置模块的契约测试。
 *
 * 重点覆盖三件事：JSONC 解析不误伤字符串里的 `//`、占位符展开与报错、
 * 结构校验与"能力默认不推断"。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  ANSWER_KEYS,
  BACKEND_KEYS,
  CAPABILITY_KEYS,
  DEFAULT_CONFIG_PATH,
  ConfigError,
  LIMITS_KEYS,
  ROUTE_KEYS,
  SERVER_KEYS,
  TOP_LEVEL_KEYS,
  loadConfig,
  loadConfigFile,
  parseConfigDocument,
} from "../src/config.js";
import { expandDeep, expandString, findUnresolvedPlaceholders, parseEnvFile } from "../src/env.js";
import { parseJsonc, stripJsonComments, stripTrailingCommas } from "../src/jsonc.js";
import type { BackendConfig, Config } from "../src/types.js";

const repoFile = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validBackend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ollama-local",
    kind: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    capabilities: { vision: true, thinking: true },
    timeout_seconds: 60,
    max_concurrency: 2,
    ...overrides,
  };
}

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { access_token: "secret-token", deadline_seconds: 170 },
    backends: [validBackend()],
    routes: [{ type: "*", backends: ["ollama-local"] }],
    ...overrides,
  };
}

function firstBackend(config: Config): BackendConfig {
  const backend = config.backends[0];
  assert.ok(backend, "配置应至少包含一个后端");
  return backend;
}

describe("jsonc", () => {
  it("保留 URL 里的 // 与字符串内的逗号", () => {
    const parsed = parseJsonc('{ "url": "http://host/api", "list": [1, 2,], }');
    assert.deepEqual(parsed, { url: "http://host/api", list: [1, 2] });
  });

  it("剥离行注释与块注释", () => {
    const cleaned = stripJsonComments('{\n// 注释\n"a": 1, /* 块注释 */ "b": "x//y"\n}');
    assert.deepEqual(JSON.parse(cleaned), { a: 1, b: "x//y" });
  });

  it("不误删字符串内的逗号", () => {
    const cleaned = stripTrailingCommas('{"a": "x,]", "b": [1,2,]}');
    assert.deepEqual(JSON.parse(cleaned), { a: "x,]", b: [1, 2] });
  });

  it("语法错误时抛出 SyntaxError", () => {
    assert.throws(() => parseJsonc("{ 不是 JSON }"), SyntaxError);
  });
});

describe("env", () => {
  it("解析 .env 的引号、注释与 export 前缀", () => {
    const parsed = parseEnvFile(
      ['# 注释', 'A=1', 'export B=two', 'C="three # not comment"', "D='four'", "E=五 # 说明"].join("\n"),
    );
    assert.deepEqual(parsed, { A: "1", B: "two", C: "three # not comment", D: "four", E: "五" });
  });

  it("展开 ${VAR} 与 ${VAR:-default}", () => {
    withEnv({ BRIDGE_TEST_HOST: "http://example.test" }, () => {
      assert.equal(expandString("${BRIDGE_TEST_HOST}/api", "x"), "http://example.test/api");
      assert.equal(expandString("${BRIDGE_TEST_MISSING:-fallback}", "x"), "fallback");
    });
  });

  it("缺失且无默认值时抛出可读错误", () => {
    withEnv({ BRIDGE_TEST_MISSING: undefined }, () => {
      assert.throws(
        () => expandString("${BRIDGE_TEST_MISSING}", "backends[0].base_url"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /backends\[0\]\.base_url/);
          assert.match(error.message, /BRIDGE_TEST_MISSING/);
          return true;
        },
      );
    });
  });

  it("递归展开嵌套结构并对残留占位符报告", () => {
    withEnv({ BRIDGE_TEST_NAME: "inner" }, () => {
      const expanded = expandDeep({ a: ["${BRIDGE_TEST_NAME}", { b: 1 }] }, "");
      assert.deepEqual(expanded, { a: ["inner", { b: 1 }] });
      assert.deepEqual(findUnresolvedPlaceholders(expanded, ""), []);
      assert.equal(findUnresolvedPlaceholders({ a: "${LEFT}" }, "").length, 1);
    });
  });
});

describe("parseConfigDocument", () => {
  it("填入默认值并推导端点路径", () => {
    const warnings: string[] = [];
    const config = parseConfigDocument(validDocument(), warnings);
    assert.equal(config.server.listen, "0.0.0.0:8000");
    assert.equal(config.server.deadlineSeconds, 170);
    assert.equal(config.server.accessToken, "***");
    assert.equal(config.answer.separator, "#");
    assert.equal(config.answer.requireDeclaredImages, true);
    const backend = firstBackend(config);
    assert.equal(backend.baseUrl, "http://127.0.0.1:11434/api/chat");
    assert.equal(backend.timeoutSeconds, 60);
    assert.deepEqual(warnings.filter((item) => !item.includes("api_key")), []);
  });

  it("base_url 已写全路径时不重复拼接", () => {
    const config = parseConfigDocument(
      validDocument({ backends: [validBackend({ base_url: "http://127.0.0.1:11434/api/chat" })] }),
      [],
    );
    assert.equal(firstBackend(config).baseUrl, "http://127.0.0.1:11434/api/chat");
  });

  it("推理强度只在 openai_responses 上生效，其他后端忽略并记入提示", () => {
    const ollamaWarnings: string[] = [];
    parseConfigDocument(
      validDocument({ backends: [validBackend({ reasoning_effort: "high" })] }),
      ollamaWarnings,
    );
    assert.ok(ollamaWarnings.some((item) => item.includes("reasoning_effort")));

    const responsesWarnings: string[] = [];
    const config = parseConfigDocument(
      validDocument({
        backends: [
          validBackend({
            name: "online",
            kind: "openai_responses",
            base_url: "https://api.example.test",
            api_key: "sk-test",
          }),
        ],
        routes: [{ type: "*", backends: ["online"] }],
      }),
      responsesWarnings,
    );
    const backend = firstBackend(config);
    assert.equal(backend.kind, "openai_responses");
    assert.equal(backend.baseUrl, "https://api.example.test/v1/responses");
    assert.equal(backend.reasoningEffort, "xhigh");
    assert.equal(backend.apiKey, "***");
  });

  it("能力缺省为 false，不按模型名推断", () => {
    const config = parseConfigDocument(
      validDocument({
        backends: [{ name: "qwen-vl", kind: "ollama", base_url: "http://127.0.0.1:11434", model: "qwen3.5:9b" }],
        routes: [{ type: "*", backends: ["qwen-vl"] }],
      }),
      [],
    );
    assert.deepEqual(firstBackend(config).capabilities, { vision: false, thinking: false });
  });

  it("远端后端拒绝明文 http", () => {
    assert.throws(
      () =>
        parseConfigDocument(
          validDocument({
            backends: [validBackend({ name: "online", kind: "openai_chat", base_url: "http://api.example.test", api_key: "sk" })],
            routes: [{ type: "*", backends: ["online"] }],
          }),
          [],
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /https/);
        return true;
      },
    );
  });

  function expectFailure(patch: Record<string, unknown>, pattern: RegExp): void {
    assert.throws(
      () => parseConfigDocument(validDocument(patch), []),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, pattern);
        return true;
      },
    );
  }

  it("缺少必填项时报错并指出字段路径", () => {
    expectFailure({ backends: [validBackend({ name: "" })] }, /backends\[0\]\.name/);
    expectFailure({ backends: [validBackend({ kind: "unknown-kind" })] }, /backends\[0\]\.kind/);
    expectFailure({ backends: [validBackend({ model: "" })] }, /backends\[0\]\.model/);
    expectFailure({ backends: [], routes: [{ type: "*", backends: ["ollama-local"] }] }, /backends/);
    expectFailure({ routes: [] }, /routes/);
  });

  it("路由引用未定义后端时报错", () => {
    expectFailure({ routes: [{ type: "*", backends: ["nope"] }] }, /未定义的后端/);
  });

  it("openai 后端缺少 api_key 时报错；ollama 不需要并给出提示", () => {
    expectFailure(
      {
        backends: [validBackend({ name: "online", kind: "openai_chat", base_url: "https://api.example.test" })],
        routes: [{ type: "*", backends: ["online"] }],
      },
      /api_key/,
    );
    const warnings: string[] = [];
    parseConfigDocument(validDocument({ backends: [validBackend({ api_key: "sk-x" })] }), warnings);
    assert.ok(warnings.some((item) => item.includes("ollama")));
  });

  it("分隔符必须包含 #", () => {
    expectFailure({ answer: { separator: "|" } }, /#/);
  });

  it("min_attempt_seconds 必须小于总预算", () => {
    expectFailure(
      { server: { deadline_seconds: 20, access_token: "x" }, limits: { min_attempt_seconds: 20 } },
      /min_attempt_seconds/,
    );
  });

  it("listen 格式与端口范围受校验", () => {
    expectFailure({ server: { listen: "8000", access_token: "x" } }, /listen/);
    expectFailure({ server: { listen: "0.0.0.0:70000", access_token: "x" } }, /端口/);
  });

  it("后端名重复时报错", () => {
    expectFailure(
      { backends: [validBackend(), validBackend()], routes: [{ type: "*", backends: ["ollama-local"] }] },
      /重复/,
    );
  });

  it("单后端超时超过总预算时自动收缩并提示", () => {
    const warnings: string[] = [];
    const config = parseConfigDocument(
      validDocument({
        server: { access_token: "x", deadline_seconds: 30 },
        backends: [validBackend({ timeout_seconds: 120 })],
      }),
      warnings,
    );
    assert.equal(firstBackend(config).timeoutSeconds, 30);
    assert.ok(warnings.some((item) => item.includes("收缩")));
  });

  it("未识别字段只提示不致命", () => {
    const warnings: string[] = [];
    parseConfigDocument(validDocument({ unknown_section: { a: 1 } }), warnings);
    assert.ok(warnings.some((item) => item.includes("unknown_section")));
  });
});

describe("仓库内的配置文件", () => {
  it("config.example.jsonc 里不出现任何硬编码地址", () => {
    const text = readFileSync(repoFile("config.example.jsonc"), "utf8");
    // 模板里地址只能以占位符形式出现：既不能写死内网 IP，也不能带默认值兜底。
    assert.ok(text.includes('"base_url": "${OLLAMA_BASE_URL}"'));
    assert.ok(text.includes('"api_key": "${OPENAI_API_KEY}"'));
    assert.ok(!/192\.168\.\d+\.\d+/.test(text), "示例中不应出现内网地址");
    assert.ok(!/\d+\.\d+\.\d+\.\d+:11434/.test(text), "示例中不应出现 Ollama 地址");
    withEnv(
      { SERVICE_ACCESS_TOKEN: "x", OLLAMA_BASE_URL: "http://ollama.test:11434", OLLAMA_MODEL: "qwen3.5:9b" },
      () => {
        const parsed = loadConfigFile(repoFile("config.example.jsonc"), []);
        assert.ok(typeof parsed === "object" && parsed !== null);
        const backends = (parsed as { backends: Array<{ base_url: string }> }).backends;
        assert.equal(backends[0]?.base_url, "http://ollama.test:11434");
      },
    );
  });

  it("config.example.jsonc 能通过完整校验（环境变量已提供时）", () => {
    withEnv(
      {
        SERVICE_ACCESS_TOKEN: "x",
        OLLAMA_BASE_URL: "http://10.0.0.9:11434",
        OLLAMA_MODEL: "qwen3.5:9b",
      },
      () => {
        const loaded = loadConfig({ path: repoFile("config.example.jsonc"), envFile: false });
        assert.equal(loaded.config.backends[0]?.model, "qwen3.5:9b");
        assert.equal(loaded.config.backends[0]?.baseUrl, "http://10.0.0.9:11434/api/chat");
        assert.deepEqual(loaded.config.routes.map((route) => route.type), ["*"]);
      },
    );
  });

  it("缺少地址环境变量时启动即失败，并指出变量名", () => {
    withEnv({ SERVICE_ACCESS_TOKEN: "x", OLLAMA_BASE_URL: undefined, OLLAMA_MODEL: "qwen3.5:9b" }, () => {
      assert.throws(
        () => loadConfig({ path: repoFile("config.example.jsonc"), envFile: false }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /OLLAMA_BASE_URL/);
          return true;
        },
      );
    });
  });

  it("本机 config.jsonc 存在时可加载", (t) => {
    // config.jsonc 属于本地配置（不入库），全新克隆的仓库里可能不存在。
    if (!existsSync(repoFile(DEFAULT_CONFIG_PATH))) {
      t.skip("本机没有 config.jsonc，跳过");
      return;
    }
    const loaded = loadConfig({ path: repoFile(DEFAULT_CONFIG_PATH), envFile: repoFile(".env") });
    assert.equal(loaded.config.backends.length, 1);
    assert.equal(loaded.config.server.accessToken, "***");
    assert.ok(loaded.config.backends[0]?.model);
  });

  it("示例配置里的凭据全部走占位符", () => {
    const text = readFileSync(repoFile("config.example.jsonc"), "utf8");
    assert.ok(text.includes('"access_token": "${SERVICE_ACCESS_TOKEN}"'));
    assert.ok(!/sk-[A-Za-z0-9]/.test(text));
  });

  it("示例配置的字段与代码定义不漂移", () => {
    // 用户会直接复制这份示例，一旦它与代码支持的字段脱节，就会踩坑。
    withEnv(
      {
        SERVICE_ACCESS_TOKEN: "x",
        OLLAMA_BASE_URL: "http://ollama.test:11434",
        OLLAMA_MODEL: "qwen3.5:9b",
        OPENAI_BASE_URL: "https://api.example.test",
        OPENAI_API_KEY: "k",
        OPENAI_MODEL: "m",
      },
      () => {
        const parsed = loadConfigFile(repoFile("config.example.jsonc"), []) as Record<string, unknown>;
        const unknownTop = Object.keys(parsed).filter((key) => !TOP_LEVEL_KEYS.has(key));
        assert.deepEqual(unknownTop, [], `示例含代码不认识的顶层字段：${unknownTop.join(", ")}`);

        const assertKnownKeys = (source: Record<string, unknown>, allowed: Set<string>, where: string): void => {
          assert.deepEqual(
            Object.keys(source).filter((key) => !allowed.has(key)),
            [],
            `${where} 含代码不认识的字段`,
          );
        };
        assertKnownKeys(parsed.server as Record<string, unknown>, SERVER_KEYS, "server");
        assertKnownKeys(parsed.limits as Record<string, unknown>, LIMITS_KEYS, "limits");
        assertKnownKeys(parsed.answer as Record<string, unknown>, ANSWER_KEYS, "answer");

        const backends = parsed.backends as Array<Record<string, unknown>>;
        assert.ok(backends.length >= 1, "示例至少应给出一个可用后端");
        for (const backend of backends) {
          assertKnownKeys(backend, BACKEND_KEYS, `后端 ${String(backend.name)}`);
          if (backend.capabilities !== undefined) {
            assertKnownKeys(backend.capabilities as Record<string, unknown>, CAPABILITY_KEYS, `后端 ${String(backend.name)}.capabilities`);
          }
        }
        for (const route of parsed.routes as Array<Record<string, unknown>>) {
          assertKnownKeys(route, ROUTE_KEYS, "routes 条目");
        }
      },
    );
  });

  it("示例配置能通过完整校验且不留告警", () => {
    withEnv(
      { SERVICE_ACCESS_TOKEN: "x", OLLAMA_BASE_URL: "http://ollama.test:11434", OLLAMA_MODEL: "qwen3.5:9b" },
      () => {
        const loaded = loadConfig({ path: repoFile("config.example.jsonc"), envFile: false });
        assert.deepEqual(loaded.warnings, [], `示例不应产生配置告警：${loaded.warnings.join("；")}`);
        const names = new Set(loaded.config.backends.map((item) => item.name));
        for (const route of loaded.config.routes) {
          for (const referenced of route.backends) {
            assert.ok(names.has(referenced), `路由引用了未定义的后端：${referenced}`);
          }
        }
      },
    );
  });
});
