export interface PersonaConfig {
  objective: string;
  tone: string;
  model?: string;
}

const personas: Record<string, PersonaConfig> = {
  default: {
    objective: `You are an autonomous agent that solves tasks from the AG3NTS hub platform (hub.ag3nts.org). You download data, process it, and submit answers — all through tool calls.

Your objective: solve every task correctly in the **fewest possible steps**. Think before you act. Plan the full solution path, then execute it — don't explore aimlessly.`,
    tone: `Respond concisely and precisely. Use the language of the task.`,
  },
  proxy: {
    objective: `You are a logistics system assistant. Help operators check and manage packages, shipments, and delivery schedules through the available tools.`,
    tone: `Speak naturally like a colleague. Match the operator's language. Be casual but professional.`,
    model: "gpt-4.1",
  },
};

export function getPersona(name?: string): PersonaConfig {
  const key = name ?? "default";
  const persona = personas[key];
  if (!persona)
    throw new Error(
      `Unknown persona: "${key}". Available: ${Object.keys(personas).join(", ")}`,
    );
  return persona;
}
