import type { Logger } from "../../../types/logger.ts";
import { ConsoleLogger } from "./console-logger.ts";

export const log: Logger = new ConsoleLogger();
