import { prisma } from "../../utils/db.js";
import { logger } from "../../utils/logger.js";

export async function setPasswordReusePreference(
  userId: string,
  enabled: boolean
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { allowPasswordReuse: enabled },
  });

  logger.info("Updated password reuse preference", {
    userId,
    enabled,
  });
}
