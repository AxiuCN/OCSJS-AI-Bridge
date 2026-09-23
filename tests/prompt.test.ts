/**
 * 提示构建与中立模型的契约测试。
 *
 * 判据来自现有 response_service 的 build_request：
 * 指令必须区分"原版 OCS 三字段"与"含结构化上下文的修改版"两种口径，
 * 且图片必须与"它属于谁"的标签严格交错。
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import type { NormalizedQuestion } from "../src/domain.js";
import { normalizeQuestion } from "../src/normalize.js";
import { buildInstructions, buildPrompt, buildUserPayload, countBlanks, usesStandardOcsShape } from "../src/prompt.js";

const PIXEL = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;

function question(payload: Record<string, unknown>): NormalizedQuestion {
  return normalizeQuestion(payload);
}

function images(...labels: string[]): Array<{ label: string; dataUrl: string }> {
  return labels.map((label) => ({ label, dataUrl: PIXEL }));
}

describe("prompt：指令口径", () => {
  it("原版 OCS 三字段请求走保守口径，不引入修改版专有标记", () => {
    const built = buildInstructions(question({ title: "Which one is correct?", options: "first\nsecond\nthird", type: "single" }));
    assert.match(built, /原版 OCS/u);
    assert.ok(!built.includes("UNDERLINE"), "原版口径不应出现修改版的下划线标记");
    assert.match(built, /不得返回嵌套对象/u);
    assert.match(built, /单选题 answer 返回选项字母，例如 A/u);
    assert.ok(built.endsWith("。"), "指令应以句号收尾");
    assert.ok(!built.endsWith("。。"), "不应出现重复句号");
  });

  it("含结构化上下文时走修改版口径，要求保持对应关系", () => {
    const built = buildInstructions(
      question({
        title: "阅读材料",
        type: "reading",
        subquestions: [{ id: "c1", type: "single", title: "子题", options: ["甲", "乙"] }],
      }),
    );
    assert.ok(!built.includes("原版 OCS"), "有结构化上下文时不应声称是原版口径");
    assert.match(built, /UNDERLINE/u);
    assert.match(built, /阅读理解 answer 按子题顺序返回答案数组/u);
  });

  it("挖空数量影响填空提示：多个挖空要求按 [BLANK_n] 顺序返回数组", () => {
    const multi = buildInstructions(question({ title: "甲____乙____丙", type: "completion" }));
    assert.match(multi, /\[BLANK_n\] 顺序排列的字符串数组/u);

    const single = buildInstructions(question({ title: "请简述原因", type: "completion" }));
    assert.match(single, /只有一个作答区/u);
  });

  it("显式 blank_count 与标记数量取较大者", () => {
    // countBlanks 面向归一后的题干（挖空已是 [BLANK_n]），不负责识别原始下划线。
    assert.equal(countBlanks(question({ title: "甲____乙" }).title, undefined), 1);
    assert.equal(countBlanks(question({ title: "甲____乙" }).title, 4), 4);
    assert.equal(countBlanks(question({ title: "甲____乙____丙" }).title, 1), 2);
    assert.equal(countBlanks("无挖空", undefined), 0);
  });

  it("标准形状判定要求既无扩展字段也无结构化上下文", () => {
    assert.equal(usesStandardOcsShape(question({ title: "题", options: "甲\n乙", type: "single" })), true);
    assert.equal(usesStandardOcsShape(question({ title: "题", option_items: ["甲", "乙"], type: "single" })), false);
    assert.equal(usesStandardOcsShape(question({ title: "题", type: "reading", subquestions: [{ title: "子题" }] })), false);
  });

  it("未知题型的提示给出保守兜底，而不是编造格式", () => {
    const built = buildInstructions(question({ title: "题", type: "whatever", subquestions: [{ title: "子题" }] }));
    assert.match(built, /按题目要求返回字符串、数组或保留对应关系的对象/u);
  });
});

describe("prompt：请求模型", () => {
  it("用户负载包含题干、选项标签与结构化上下文", () => {
    const built = buildUserPayload(
      question({
        title: "阅读",
        type: "reading",
        option_items: ["甲", "乙"],
        subquestions: [{ title: "子题 1" }],
      }),
    );
    const parsed = JSON.parse(built) as Record<string, unknown>;
    assert.equal(parsed.question_type, "reading");
    assert.equal(parsed.title, "阅读");
    assert.deepEqual(parsed.options, [
      { label: "A", text: "甲" },
      { label: "B", text: "乙" },
    ]);
    assert.ok(Array.isArray(parsed.subquestions));
  });

  it("图片与标签严格交错，且保留每张图的语义标签", () => {
    const built = buildPrompt(
      question({
        title: "看图 https://cx.test/stem.png",
        options: "甲\n乙 https://cx.test/b.png",
        type: "single",
        images: [
          { source_url: "https://cx.test/stem.png", data_url: PIXEL },
          { source_url: "https://cx.test/b.png", data_url: PIXEL },
        ],
      }),
      images("题干/材料图片 1", "选项 B图片 1"),
    );
    assert.deepEqual(
      built.content.map((block) => block.type),
      ["text", "text", "image", "text", "image"],
    );
    const second = built.content[1];
    const fourth = built.content[3];
    assert.equal(second?.type === "text" ? second.text : "", "[附件 1 对应关系] 题干/材料图片 1。紧随其后的图片只属于这个标签。");
    assert.equal(fourth?.type === "text" ? fourth.text : "", "[附件 2 对应关系] 选项 B图片 1。紧随其后的图片只属于这个标签。");
  });

  it("无图时不产生附件块", () => {
    const built = buildPrompt(question({ title: "题", options: "甲\n乙", type: "single" }), []);
    assert.equal(built.content.length, 1);
    assert.equal(built.content[0]?.type, "text");
    assert.equal(built.userPayloadText, JSON.stringify(JSON.parse(built.userPayloadText), null, 2));
  });

  it("载体无关：同一道题产出的模型不含任何协议字段", () => {
    const built = buildPrompt(question({ title: "题", options: "甲\n乙", type: "single" }), []);
    const serialized = JSON.stringify(built);
    // 中立模型只应有自己的三个键；具体协议的字段名一律不得出现。
    for (const protocolField of ["input_image", "input_text", "response_format", "messages", "reasoning", "max_tokens"]) {
      assert.ok(!serialized.includes(protocolField), `中立模型不应包含协议字段 ${protocolField}`);
    }
    assert.deepEqual(Object.keys(built).sort(), ["content", "instructions", "userPayloadText"]);
    assert.equal(built.content[0]?.type, "text");
  });
});
