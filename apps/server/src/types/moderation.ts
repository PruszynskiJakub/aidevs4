export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
}
