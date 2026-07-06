import { PersonaEngine, PersonaInput } from "./types";

/**
 * 离线模板人设层：无需任何密钥，从工作层输出里抽取要点，套上指挥官口吻。
 * 这是 auto 模式在没有 API key 时的降级实现，保证开箱即跑。
 */
export class TemplatePersona implements PersonaEngine {
  readonly mode = "template";

  constructor(
    private personaName: string,
    private projectInstructions?: string,
  ) {}

  async report(input: PersonaInput): Promise<string> {
    const { workerText } = input;
    const clean = workerText.replace(/\s+/g, " ").trim();
    const brief = clean.length > 240 ? clean.slice(0, 240) + "…" : clean;

    const kaomoji = pick(["(≧▽≦)", "ฅ^•ﻌ•^ฅ", "(ノ´ヮ`)ノ*:・゚✧", "(´・ω・`)", "(｡♥‿♥｡)", "(*´▽`*)", "(｡>﹏<｡)", "🐾✨"]);

    // ponytail: 模板兜底——开头直入工作内容，称呼放后面。
    return brief ? `${brief} 喵~ ${kaomoji}` : `这一轮工作层没有产出可汇报的内容呢，主人～ ${kaomoji}`;
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
