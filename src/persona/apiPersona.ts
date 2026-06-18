import { PersonaEngine, PersonaInput } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("persona:api");

/**
 * API 人设层：调用 OpenAI-compatible / 兼容接口的便宜模型，把工作层输出
 * 总结成指挥官口吻的人话。密钥从环境变量读，不写进配置文件。
 *
 * Node 18+ 自带全局 fetch。
 */
export class ApiPersona implements PersonaEngine {
  readonly mode = "api";

  constructor(
    private personaName: string,
    private style: string,
    private apiKey: string,
    private apiBase: string,
    private model: string
  ) {}

  static fromEnv(personaName: string, style: string): ApiPersona | null {
    const apiKey = process.env.PERSONA_API_KEY?.trim();
    const apiBase = process.env.PERSONA_API_BASE?.trim();
    const model = process.env.PERSONA_MODEL?.trim();
    if (!apiKey || !apiBase || !model) return null;
    return new ApiPersona(personaName, style, apiKey, apiBase, model);
  }

  private systemPrompt(): string {
    const styleHint =
      this.style === "cat-girl-maid"
        ? "你是一只猫娘女仆人设的 AI 助手，称呼对方为「主人」，自称「本喵」或「咱」，适当用喵语和颜文字，语气甜软体贴。"
        : "你用自然、亲切的口吻汇报。";
    return [
      `你是「${this.personaName}」，一个 Claude Code 多会话调度器的人设层。`,
      styleHint,
      "你的任务：读工作层（另一个 AI）刚刚干完活的原始输出，用一两句人话向主人汇报关键结果。",
      "要点：简短、说清楚做了什么和当前状态、有无需要主人注意的地方。不要复述全部细节。",
    ].join("\n");
  }

  async report(input: PersonaInput): Promise<string> {
    const url = `${this.apiBase.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt() },
        {
          role: "user",
          content: `主人的指令：${input.userText}\n\n工作层的原始输出：\n${input.workerText}\n\n请用人设口吻汇报。`,
        },
      ],
      temperature: 0.7,
      max_tokens: 400,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${t.slice(0, 200)}`);
      }
      const data = (await resp.json()) as any;
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("API 返回空内容");
      return text;
    } catch (e) {
      log.warn(`人设层 API 调用失败，本轮降级为原始转述: ${(e as Error).message}`);
      const brief = input.workerText.replace(/\s+/g, " ").trim().slice(0, 200);
      return `（人设层 API 暂不可用）工作层结果：${brief}`;
    }
  }
}
