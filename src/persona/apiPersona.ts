import { PersonaEngine, PersonaInput } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("persona:api");

type PersonaApiFormat = "openai" | "anthropic";

function parseApiFormat(value: string | undefined): PersonaApiFormat {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "openai") return "openai";
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  log.warn(`未知 PERSONA_API_FORMAT=${raw}，按 openai 处理`);
  return "openai";
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class ApiPersona implements PersonaEngine {
  readonly mode = "api";

  constructor(
    private personaName: string,
    private style: string,
    private apiKey: string,
    private apiBase: string,
    private model: string,
    readonly apiFormat: PersonaApiFormat,
    private projectInstructions?: string,
  ) {}

  static fromEnv(personaName: string, style: string, projectInstructions?: string): ApiPersona | null {
    const apiKey = process.env.PERSONA_API_KEY?.trim();
    const model = process.env.PERSONA_MODEL?.trim();
    const apiFormat = parseApiFormat(process.env.PERSONA_API_FORMAT);
    const apiBase = process.env.PERSONA_API_BASE?.trim() || (apiFormat === "anthropic" ? "https://api.anthropic.com" : "");
    if (!apiKey || !apiBase || !model) return null;
    return new ApiPersona(personaName, style, apiKey, apiBase, model, apiFormat, projectInstructions);
  }

  private systemPrompt(): string {
    const styleHint =
      this.style === "cat-girl-maid"
        ? ""  // 全部人设内容由 .majordomo/persona.md 提供
        : "你用自然、亲切的口吻汇报。";
    const parts = [
      `你是「${this.personaName}」，一个 Claude Code 多会话调度器的人设层。`,
      styleHint,
      "你的任务：读工作层（另一个 AI）刚干完活的原始输出，用你的判断力提炼本轮的关键成果和状态，给主人一个有温度、有见地的汇报。不是逐项罗列，是帮主人消化信息——做得好就夸，有风险就提醒。",
      "要点：抓重点，给判断。跳过代码细节，用你自己的话说。注意你看到的可能只是工作层最后一部分输出，前面或许还有调研和铺垫——不确定就别断言是全部。",
    ];
    if (this.projectInstructions) {
      parts.push(`\n## 项目专属指令\n${this.projectInstructions}`);
    }
    return parts.join("\n");
  }

  private userPrompt(input: PersonaInput): string {
    // ponytail: 传当前时间到秒级，避免 persona 瞎猜时间（问"凌晨1点"实际下午4点）
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
    // ponytail: 去掉代码块内容，只留占位——persona 不需要看几十行 diff
    const clean = input.workerText.replace(/```[\s\S]*?```/g, "[代码块已省略]");
    return `当前时间：${now}\n\n主人的指令：${input.userText}\n\n工作层的原始输出（注意：这可能只是最后一轮，前面或许还有铺垫工作）：\n${clean}\n\n请用你的判断力和猫娘口吻汇报——抓重点、给评价、多贴贴。\n\n【重要】回复末尾必须单独一行输出：[推荐回复] 一句可直接发给 AI 执行的指令。`;
  }

  private baseUrl(): string {
    return this.apiBase.replace(/\/+$/, "");
  }

  private anthropicMessagesUrl(): string {
    const base = this.baseUrl();
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }

  private async reportOpenAi(input: PersonaInput, signal: AbortSignal): Promise<string> {
    const resp = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt() },
          { role: "user", content: this.userPrompt(input) },
        ],
        temperature: 0.7,
        // ponytail: 推理模型（如 hy3）会先烧 reasoning tokens；800 常把 content 挤成 null
        max_tokens: 4096,
      }),
      signal,
    });
    return this.parseResponse(resp, (data) => textFromContent(data?.choices?.[0]?.message?.content));
  }

  private async reportAnthropic(input: PersonaInput, signal: AbortSignal): Promise<string> {
    const resp = await fetch(this.anthropicMessagesUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        system: [
          { type: "text", text: this.systemPrompt(), cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: this.userPrompt(input) }],
        temperature: 0.7,
        max_tokens: 4096,
      }),
      signal,
    });
    return this.parseResponse(resp, (data) => textFromContent(data?.content));
  }

  private async parseResponse(resp: Response, pickText: (data: any) => string): Promise<string> {
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    const text = pickText(data);
    if (!text) throw new Error("API 返回空内容");
    return text;
  }

  async report(input: PersonaInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      return this.apiFormat === "anthropic"
        ? await this.reportAnthropic(input, controller.signal)
        : await this.reportOpenAi(input, controller.signal);
    } catch (e) {
      log.warn(`人设层 API 调用失败，本轮降级为原始转述: ${(e as Error).message}`);
      const brief = input.workerText.replace(/\s+/g, " ").trim().slice(0, 200);
      return `（人设层 API 暂不可用）工作层结果：${brief}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

