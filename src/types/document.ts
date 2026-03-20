export interface DocumentMetadata {
  source: string | null;
  sessionUuid: string;
  tokens: number;
  type: "document" | "text" | "image";
  mime_type: string;
}

export interface Document {
  uuid: string;
  text: string;
  description: string;
  metadata: DocumentMetadata;
}
