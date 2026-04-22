import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import { ModelState } from "@/sentinel/model-state"

export const SentinelRoutes = () =>
  new Hono()
    .post(
      "/preload",
      describeRoute({
        summary: "Preload a model",
        description:
          "Hot-swap the LLM container to load a model. Blocks until the model is healthy or the swap fails.",
        operationId: "sentinel.preload",
        responses: {
          200: {
            description: "Preload result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    model: z.string().optional(),
                    status: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          model: z.string().describe("GGUF filename to load"),
        }),
      ),
      async (c) => {
        const { model } = c.req.valid("json")
        const projectDir = Instance.directory
        const success = await ModelState.ensure(model, projectDir)
        return c.json({
          success,
          model: ModelState.currentModel(),
          status: ModelState.status(),
        })
      },
    )
    .get(
      "/model",
      describeRoute({
        summary: "Get current model status",
        description: "Returns the currently loaded model and swap status.",
        operationId: "sentinel.model",
        responses: {
          200: {
            description: "Model status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    status: z.string(),
                    model: z.string().optional(),
                    target: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        await ModelState.detect()
        return c.json({
          status: ModelState.status(),
          model: ModelState.currentModel(),
          target: ModelState.targetModel(),
        })
      },
    )
