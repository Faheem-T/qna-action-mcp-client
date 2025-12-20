import z from "zod";

export const intentResourceSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string(),
    allowed_tools: z.string().array(),
  }),
);
