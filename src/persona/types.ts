/**
 * 人设层（指挥官的"嘴"）。
 *
 * 职责：读工作层的结构化输出，用人话向主人汇报。无 agent 能力，纯文本对话。
 * 实现：ApiPersona（OpenAI-compatible / Anthropic Messages API）、TemplatePersona（离线模板，无需密钥）。

 */
export interface PersonaInput {
  /** 主人这一轮的指令 */
  userText: string;
  /** 工作层这一轮的原始输出（已聚合） */
  workerText: string;
  /** 会话名 */
  sessionName: string;
}

/** 一条聊天历史（跟工作层复命历史分开，语义不同，不共用）。 */
export interface ChatTurn {
  role: "user" | "persona";
  text: string;
}

export interface PersonaEngine {
  readonly mode: string;
  /**
   * 把结构化结果总结成人话汇报。
   * @param onDelta 可选：累计文本回调（流式）；phase=reasoning 仅心跳展示，终稿只用 content。
   */
  report(
    input: PersonaInput,
    onDelta?: (accumulated: string, phase?: "reasoning" | "content") => void,
  ): Promise<string>;

  /**
   * 直接聊天（跟工作流平行，不涉及 workerText）。history 是最近几条聊天往回，不含本轮。
   */
  chat(
    text: string,
    history: ChatTurn[],
    onDelta?: (accumulated: string, phase?: "reasoning" | "content") => void,
  ): Promise<string>;
}
