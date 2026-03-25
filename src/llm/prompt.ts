import { join } from "path";
import matter from "gray-matter";
import { files } from "../infra/file.ts";

export interface PromptResult {
  model?: string;
  temperature?: number;
  content: string;
}

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

export function createPromptService(promptsDir = PROMPTS_DIR) {
  return {
    async load(
      name: string,
      variables?: Record<string, string>,
    ): Promise<PromptResult> {
      const filePath = join(promptsDir, `${name}.md`);
      const raw = await files.readText(filePath);
      const { data, content } = matter(raw);

      const rendered = content.trim().replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!variables || !(key in variables)) {
          throw new Error(`Missing placeholder variable: {{${key}}}`);
        }
        return variables[key];
      });

      return {
        ...(data.model !== undefined && { model: data.model as string }),
        ...(data.temperature !== undefined && {
          temperature: data.temperature as number,
        }),
        content: rendered,
      };
    },
  };
}

export const promptService = createPromptService();
