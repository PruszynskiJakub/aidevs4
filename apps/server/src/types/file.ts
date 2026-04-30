// Provider-agnostic file I/O types — no runtime-specific imports allowed here

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export type WritableData = string | Response;

export interface FileProvider {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  readJson<T = unknown>(path: string): Promise<T>;
  write(path: string, data: WritableData): Promise<void>;
  append(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string): Promise<void>; // always recursive
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  checkFileSize(path: string, maxBytes?: number): Promise<void>;
  /**
   * Return a FileProvider whose write-path narrowing is scoped to the
   * given sessionId. Reads are unaffected. The original instance is not
   * mutated. When sessionId is omitted, an instance with no session
   * scope is returned (writes that target `sessionsDir` will not be
   * narrowed to a per-session subfolder).
   */
  scoped(sessionId?: string): FileProvider;
}
