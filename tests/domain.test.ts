/**
 * 领域层契约测试：逐条对齐现有 response_service 的 normalize / images / format 行为。
 *
 * 这些用例是"不退化"的判据——任何一条失败都意味着 OCS 的回填结果与原来不同。
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { ImagePreparationError, type NormalizedQuestion } from "../src/domain.js";
import { formatOcsAnswer } from "../src/format.js";
import { ImagePreparer, sniffImageMime, type ImageLimits } from "../src/images.js";
import { normalizeBlanks, normalizeQuestion, normalizeQuestionType, splitOptions } from "../src/normalize.js";

const PIXEL = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;

const LIMITS: ImageLimits = {
  imageTimeoutSeconds: 10,
  maxImages: 24,
  maxImageBytes: 4096,
  imageConcurrency: 2,
  requireDeclaredImages: true,
};

function fakeFetch(
  responder: (url: string, headers: Record<string, string>) => Response | Promise<Response>,
): { impl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, headers });
    return responder(url, headers);
  }) as typeof fetch;
  return { impl, calls };
}

const realFetch = fetch;

async function prepare(
  question: NormalizedQuestion,
  options: { fetchImpl?: typeof fetch; limits?: Partial<ImageLimits> } = {},
): Promise<{ images: Array<{ label: string; dataUrl: string }>; warnings: string[] }> {
  const preparer = new ImagePreparer({ ...LIMITS, ...options.limits }, options.fetchImpl ?? realFetch);
  return preparer.prepare(question, new AbortController().signal);
}

describe("normalize：题目归一", () => {
  it("原版 OCS 字段被识别为 standard，且不假设存在额外 DOM 结构", () => {
    const question = normalizeQuestion({
      title: "Which one is correct?",
      options: "first\nsecond\nthird",
      type: "single",
    });
    assert.equal(question.standardOcs, true);
    assert.equal(question.questionType, "single");
    assert.deepEqual(question.options, ["first", "second", "third"]);
    assert.deepEqual(question.originalOptions, ["first", "second", "third"]);
    assert.deepEqual(question.attachments, []);
  });

  it("缺少 type 时按选项推断，不强行当成单选", () => {
    assert.equal(normalizeQuestion({ title: "选择", options: "甲\n乙\n丙" }).questionType, "choice");
    assert.equal(normalizeQuestion({ title: "判断", options: "正确\n错误" }).questionType, "judgement");
    assert.equal(normalizeQuestion({ title: "简述原因" }).questionType, "completion");
  });

  it("题干/选项的图片与挖空都被标记", () => {
    const question = normalizeQuestion({
      type: "single",
      title: "看图 https://cx.test/stem.png 填写____，另一个答案写在（     ）",
      options: "红色 https://cx.test/a.png\n蓝色 https://cx.test/b.png",
      images: [
        { source_url: "https://cx.test/stem.png", data_url: PIXEL },
        { source_url: "https://cx.test/a.png", data_url: PIXEL },
        { source_url: "https://cx.test/b.png", data_url: PIXEL },
      ],
    });
    assert.match(question.title, /\[题干\/材料图片 1\]/u);
    assert.match(question.title, /\[BLANK_1\]/u);
    assert.match(question.title, /（\[BLANK_2\]）/u);
    assert.match(question.options[0]!, /\[选项 A图片 1\]/u);
    assert.deepEqual(
      question.attachments.map((item) => item.label),
      ["题干/材料图片 1", "选项 A图片 1", "选项 B图片 1"],
    );
  });

  it("结构化 option_items 优先于扁平 options，且内部换行保留", () => {
    const question = normalizeQuestion({
      title: "选择图片",
      options: "旧的扁平字符串",
      option_items: ["选项 A 第一行\n选项 A 第二行 https://cx.test/a.png", "选项 B https://cx.test/b.png"],
      images: [
        { source_url: "https://cx.test/a.png", data_url: PIXEL },
        { source_url: "https://cx.test/b.png", data_url: PIXEL },
      ],
    });
    assert.equal(question.options.length, 2);
    assert.match(question.options[0]!, /\[选项 A图片 1\]/u);
    assert.match(question.options[1]!, /\[选项 B图片 1\]/u);
    // 出现扩展字段即非原版 OCS 请求
    assert.equal(question.standardOcs, false);
  });

  it("结构化上下文字段带作用域前缀，图片全部登记", () => {
    const question = normalizeQuestion({
      title: "阅读材料",
      type: "reading",
      material: "材料图 https://cx.test/material.png",
      subquestions: [
        { id: "child-1", type: "single", title: "子题图 https://cx.test/child.png", options: ["甲", "乙 https://cx.test/child-b.png"] },
      ],
      images: [
        { source_url: "https://cx.test/material.png", data_url: PIXEL },
        { source_url: "https://cx.test/child.png", data_url: PIXEL },
        { source_url: "https://cx.test/child-b.png", data_url: PIXEL },
      ],
    });
    assert.match(String(question.context.material), /\[material图片 1\]/u);
    const subquestions = question.context.subquestions as Array<Record<string, unknown>>;
    assert.match(String(subquestions[0]!.title), /\[subquestions 1\/title图片 1\]/u);
    assert.match(String((subquestions[0]!.options as string[])[1]), /\[subquestions 1\/options 2图片 1\]/u);
    assert.equal(question.attachments.length, 3);
  });

  it("同一地址的扁平与结构化引用只送一次，标签合并", () => {
    const question = normalizeQuestion({
      title: "阅读",
      type: "reading",
      option_items: ["甲 https://cx.test/shared.png"],
      subquestions: [{ title: "子题", options: ["甲 https://cx.test/shared.png"] }],
      images: [{ source_url: "https://cx.test/shared.png", data_url: PIXEL }],
    });
    assert.equal(question.attachments.length, 1);
    assert.match(question.attachments[0]!.label, /选项 A图片 1/u);
    assert.match(question.attachments[0]!.label, /subquestions 1\/options 1图片 1/u);
  });

  it("OCSJS 5.x 纯 data URL 图片数组：数量对齐时按顺序绑定语义标签", () => {
    const second = `data:image/png;base64,${Buffer.from("png2").toString("base64")}`;
    const question = normalizeQuestion({
      title: "看图 https://cx.test/stem.png 选择",
      options: "甲 https://cx.test/a.png\n乙",
      type: "single",
      // 5.x 通过 data.images.handler 提交的就是纯 data URL 数组，没有 source_url
      images: [PIXEL, second],
    });
    assert.equal(question.attachments.length, 2, "不应把同一批图片重复登记");
    assert.equal(question.attachments[0]!.label, "题干/材料图片 1");
    assert.equal(question.attachments[0]!.dataUrl, PIXEL);
    assert.equal(question.attachments[1]!.label, "选项 A图片 1");
    assert.equal(question.attachments[1]!.dataUrl, second);
  });

  it("数量不对齐时不强行配对，退回原行为并保留全部附件", () => {
    const question = normalizeQuestion({
      title: "看图 https://cx.test/stem.png 和 https://cx.test/b.png",
      options: "甲",
      type: "single",
      images: [PIXEL], // 只给了一张，无法判断对应关系
    });
    // 两张来自文本的图片 + 一张浏览器提交的未分类图片
    assert.equal(question.attachments.length, 3);
    assert.equal(question.attachments.at(-1)!.label, "未分类图片 1");
    assert.equal(question.attachments.at(-1)!.dataUrl, PIXEL);
  });

  it("浏览器已提交 data URL 时不再为同一批图片下载一次", async () => {
    const { impl, calls } = fakeFetch(() => new Response("should not be called", { status: 500 }));
    const question = normalizeQuestion({
      title: "看图 https://cx.test/stem.png",
      options: "甲",
      type: "single",
      images: [PIXEL],
    });
    const result = await prepare(question, { fetchImpl: impl });
    assert.equal(result.images.length, 1);
    assert.equal(calls.length, 0, "已有 data URL 时必须跳过服务端下载");
  });

  it("挖空与选项拆分工具函数保持既有行为", () => {
    // 已有 [BLANK_2] 时，新挖空从 3 号开始编号（与原实现一致）
    assert.equal(normalizeBlanks("甲____乙 [BLANK_2]"), "甲[BLANK_3]乙 [BLANK_2]");
    assert.equal(normalizeBlanks("（     ）"), "（[BLANK_1]）");
    assert.deepEqual(splitOptions("甲\r\n乙\n\n丙 "), ["甲", "乙", "丙"]);
    assert.deepEqual(splitOptions(["甲", "", "乙"]), ["甲", "乙"]);
    assert.equal(normalizeQuestionType("单选题", []), "single");
    assert.equal(normalizeQuestionType("truefalse", []), "judgement");
    assert.equal(normalizeQuestionType("fill_blank", []), "completion");
  });
});

describe("images：图片准备", () => {
  it("题目声明有图但一张都读不到时直接失败，不猜答案", async () => {
    const { impl } = fakeFetch(() => new Response("forbidden", { status: 403 }));
    const question = normalizeQuestion({ title: "https://cx.test/protected.png", type: "single" });
    await assert.rejects(
      () => prepare(question, { fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof ImagePreparationError);
        assert.match(error.message, /没有拿到任何可读图片/u);
        return true;
      },
    );
  });

  it("服务端下载带超星请求头，并按魔术字节嗅探类型", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const { impl, calls } = fakeFetch(
      () => new Response(png, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const question = normalizeQuestion({ title: "https://p.ananas.chaoxing.com/objectid/abc", type: "single" });
    const result = await prepare(question, { fetchImpl: impl });
    assert.equal(result.images.length, 1);
    assert.match(result.images[0]!.dataUrl, /^data:image\/png;base64,/u);
    assert.deepEqual(result.warnings, []);
    assert.equal(calls[0]!.headers.referer, "https://p.ananas.chaoxing.com/");
    assert.match(calls[0]!.headers["user-agent"] ?? "", /Chrome\/120/u);
  });

  it("浏览器提交的 data URL 被校验：格式非法或超限都记 warning", async () => {
    const question = normalizeQuestion({
      title: "题目",
      type: "single",
      images: [
        { source_url: "https://cx.test/a.png", data_url: "data:text/plain;base64,AAAA" },
        { source_url: "https://cx.test/b.png", data_url: `data:image/png;base64,${"A".repeat(9000)}` },
        { source_url: "https://cx.test/c.png", data_url: PIXEL },
      ],
    });
    const result = await prepare(question);
    assert.equal(result.images.length, 1);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0]!, /不是有效的 image data URL/u);
    assert.match(result.warnings[1]!, /超过服务端大小限制/u);
  });

  it("require_declared_images 为 false 时，读不到图也照常作答", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 404 }));
    const question = normalizeQuestion({ title: "https://cx.test/x.png", type: "single" });
    const result = await prepare(question, { fetchImpl: impl, limits: { requireDeclaredImages: false } });
    assert.equal(result.images.length, 0);
    assert.equal(result.warnings.length, 1);
  });

  it("单个地址重复出现时只下载一次", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { impl, calls } = fakeFetch(() => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const question = normalizeQuestion({
      title: "图 https://cx.test/same.png 和 https://cx.test/same.png",
      type: "single",
    });
    await prepare(question, { fetchImpl: impl });
    assert.equal(calls.length, 1);
  });

  it("远端声明超大 Content-Length 时直接拒绝并主动取消响应体", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.alloc(64, 0x41));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { impl } = fakeFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "99999999" },
        }),
    );
    const question = normalizeQuestion({ title: "https://cx.test/huge.png", type: "single" });
    // 关掉 requireDeclaredImages：这里要验证单张失败的原因，而不是题目级中止
    const result = await prepare(question, { fetchImpl: impl, limits: { requireDeclaredImages: false } });
    assert.equal(result.images.length, 0, "声明超限的图片不得进入 data URL（即没有整块读进内存）");
    assert.match(result.warnings[0]!, /超过服务端大小限制/u);
    assert.equal(cancelled, true, "应主动取消响应体，及时释放连接与缓冲");
  });

  it("未声明 Content-Length 时也按流式累计拒绝超限图片", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 200) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.alloc(1024, 0x41));
      },
    });
    const { impl } = fakeFetch(() => new Response(stream, { status: 200, headers: { "content-type": "image/png" } }));
    const question = normalizeQuestion({ title: "https://cx.test/stream.png", type: "single" });
    const result = await prepare(question, {
      fetchImpl: impl,
      limits: { maxImageBytes: 4096, requireDeclaredImages: false },
    });
    assert.equal(result.images.length, 0);
    assert.match(result.warnings[0]!, /超过服务端大小限制/u);
    assert.ok(pulls < 200, `超限后应立即停止读取，实际拉取了 ${pulls} 次`);
  });

  it("图片下载遇到 HTTP 错误时不误报为内容类型问题", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 500 }));
    const question = normalizeQuestion({ title: "https://cx.test/err.png", type: "single" });
    const result = await prepare(question, { fetchImpl: impl, limits: { requireDeclaredImages: false } });
    assert.equal(result.images.length, 0);
    assert.match(result.warnings[0]!, /HTTP 500/u);
  });

  it("魔术字节嗅探覆盖常见格式", () => {
    assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageMime(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniffImageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("BMxxxx")), "image/bmp");
    assert.equal(sniffImageMime(Buffer.from("not an image")), "");
  });
});

describe("format：答案格式化", () => {
  it("多选字母被映射回原始选项文本", () => {
    const question = normalizeQuestion({ title: "选择", options: "甲\n乙\n丙", type: "multiple" });
    assert.equal(formatOcsAnswer(["A", "C"], question, "#"), "甲#丙");
  });

  it("原版 OCS 的选择题字母回填为精确选项文本", () => {
    const single = normalizeQuestion({ title: "选择", options: "quiet\nsociable\nunknown", type: "single" });
    const multiple = normalizeQuestion({ title: "多选", options: "first\nsecond\nthird", type: "multiple" });
    assert.equal(formatOcsAnswer("B", single, "#"), "sociable");
    assert.equal(formatOcsAnswer(["A", "C"], multiple, "#"), "first#third");
    assert.equal(formatOcsAnswer("A#C", multiple, "#"), "first#third");
    // 无法识别的字母组合原样返回，不猜测
    assert.equal(formatOcsAnswer("BAD", multiple, "#"), "BAD");
  });

  it("覆盖上游可能返回的全部答案形状", () => {
    const cases: Array<[string, unknown, string]> = [
      ["single", "b", "B"],
      ["multiple", ["a", "c"], "A#C"],
      ["choice", ["b", "d"], "B#D"],
      ["judgement", "true", "正确"],
      ["completion", ["第一空", "第二空"], "第一空#第二空"],
      ["line", [{ left: "甲", right: "B" }, { left: "乙", right: "A" }], "B#A"],
      ["fill", ["A", "C", "B"], "A#C#B"],
      ["reader", [{ answer: "a" }, { answer: "a" }], "A#A"],
    ];
    for (const [type, answer, expected] of cases) {
      const question = normalizeQuestion({ title: "题目", type });
      assert.equal(question.standardOcs, true, `${type} 应被识别为原版 OCS`);
      assert.equal(formatOcsAnswer(answer, question, "#"), expected, `题型 ${type}`);
    }
  });

  it("连线题的 pairs 按左侧顺序摊平", () => {
    const question = normalizeQuestion({ title: "连线", type: "line" });
    assert.equal(formatOcsAnswer({ pairs: [{ left: "甲", right: "2" }, { left: "乙", right: "1" }] }, question, "#"), "2#1");
  });

  it("匹配别名（matching）同样摊平 pairs，且保留 JSON 用于浏览器绑定", () => {
    const question = normalizeQuestion({ title: "匹配", type: "matching" });
    assert.equal(formatOcsAnswer({ pairs: [{ left: "甲", right: "B" }, { left: "乙", right: "A" }] }, question, "#"), "B#A");
  });

  it("复合题的嵌套答案保持 JSON", () => {
    const question = normalizeQuestion({
      title: "阅读",
      type: "reading",
      subquestions: [{ title: "子题 1" }, { title: "子题 2" }, { title: "子题 3" }],
    });
    const answer = [
      { answer: "A" },
      { answer: ["B", "D"] },
      { answer: "正文" },
    ];
    assert.deepEqual(JSON.parse(formatOcsAnswer(answer, question, "#")), answer);
  });

  it("判断题归一为 正确/错误，未知取值原样保留", () => {
    const question = normalizeQuestion({ title: "判断", options: "正确\n错误", type: "judgement" });
    for (const value of ["true", "T", "对", "√", "1"]) {
      assert.equal(formatOcsAnswer(value, question, "#"), "正确");
    }
    for (const value of ["false", "F", "错", "×", "0"]) {
      assert.equal(formatOcsAnswer(value, question, "#"), "错误");
    }
    assert.equal(formatOcsAnswer("也许", question, "#"), "也许");
  });

  it("空答案与 null 被如实表达，不伪造内容", () => {
    const question = normalizeQuestion({ title: "题目", type: "completion" });
    assert.equal(formatOcsAnswer("", question, "#"), "");
    assert.equal(formatOcsAnswer(null, question, "#"), "");
    assert.equal(formatOcsAnswer([], question, "#"), "");
    assert.equal(formatOcsAnswer({ answer: null }, question, "#"), "");
  });

  it("分隔符按配置生效", () => {
    const question = normalizeQuestion({ title: "填空", type: "completion" });
    assert.equal(formatOcsAnswer(["甲", "乙"], question, "#"), "甲#乙");
    assert.equal(formatOcsAnswer(["甲", "乙"], question, "#|#"), "甲#|#乙");
  });
});
