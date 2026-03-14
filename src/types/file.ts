// Provider-agnostic file I/O types — no runtime-specific imports allowed here

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export type WritableData = string | Response;

export interface FileProvider {
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  readJson<T = unknown>(path: string): Promise<T>;
  write(path: string, data: WritableData): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string): Promise<void>; // always recursive
}
