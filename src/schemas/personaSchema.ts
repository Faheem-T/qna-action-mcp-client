import z from "zod";

export const PersonaSchema = z.object({
  name: z.string(),
  system_prompt: z.string(),
  max_response_tokens: z.number().int().positive().optional(),
});
