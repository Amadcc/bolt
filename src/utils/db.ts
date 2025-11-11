import { PrismaClient } from "@prisma/client";
import {
  decrementDbActivity,
  incrementDbActivity,
  trackDatabaseQuery,
} from "./metrics.js";

const prismaBase = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

export const prisma = prismaBase.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: {
        model: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        incrementDbActivity();
        const start = Date.now();
        try {
          const result = await query(args);
          trackDatabaseQuery(
            model ?? "raw",
            (operation as string) ?? "query",
            Date.now() - start
          );
          return result;
        } finally {
          decrementDbActivity();
        }
      },
    },
  },
});

// Graceful shutdown
process.on("beforeExit", async () => {
  await prismaBase.$disconnect();
});
