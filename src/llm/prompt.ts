import { join } from "path";
import matter from "gray-matter";
import * as fs from "../infra/fs.ts";
import { config } from "../config/index.ts";
import type { PromptResult } from "../types/prompt.ts";

export type { PromptResult } from "../types/prompt.ts";

export function createPromptService(promptsDir = config.paths.promptsDir) {
  return {
    async load(
      name: string,
      variables?: Record<string, string>,
    ): Promise<PromptResult> {
      const filePath = join(promptsDir, `${name}.md`);
      const raw = await fs.readText(filePath);
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
