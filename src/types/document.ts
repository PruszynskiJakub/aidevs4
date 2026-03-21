import type { MediaCategory } from "../utils/media-types.ts";

export interface DocumentMetadata {
  source: string | null;
  sessionUuid: string;
  tokens: number;
  type: MediaCategory;
  mimeType: string;
}

export interface Document {
  uuid: string;
  text: string;
  description: string;
  metadata: DocumentMetadata;
}
