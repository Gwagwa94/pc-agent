import type OpenAI from 'openai';

export interface PlannerDecision {
  status: 'CONTINUE' | 'DONE' | 'FAILED' | 'NEED_SNAPSHOT';
  thought: string;
  subtask_instruction: string;
  allowed_tools: string[];
  max_steps: number;
  final_response?: string | undefined;
}

export type SnapResult = {
  text: string;
  images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[];
  fgTitle: string;
};
